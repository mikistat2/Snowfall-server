import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler } from '../utils/async';
import { validate } from '../middleware/validate';
import multer from 'multer';
import { requireAuth, requireOwner, blockFrozenGym, requireActiveSubscription, requireFeature } from '../middleware/auth';
import { pageParams, pagedBody } from '../utils/pagination';
import { adminRouter } from './admin';
import * as auth from '../controllers/authController';
import * as plans from '../controllers/planController';
import * as members from '../controllers/memberController';
import * as checkIns from '../controllers/checkInController';
import * as payments from '../controllers/paymentController';
import * as dashboard from '../controllers/dashboardController';
import * as settings from '../controllers/settingsController';
import * as telegram from '../controllers/telegramController';
import * as guests from '../controllers/guestController';
import * as billing from '../controllers/billingController';
import * as features from '../controllers/featureController';
import * as auditLogModel from '../models/auditLogModel';
import * as platformModel from '../models/platformModel';
import { cameraProxy } from '../controllers/cameraProxyController';
import * as feedback from '../controllers/feedbackController';

export const api = Router();

// ---------- schemas ----------
const descriptor = z.array(z.number()).length(128);
const paymentMethod = z.enum(['cash', 'telebirr', 'bank', 'other']);

const registerGymSchema = z.object({
  gym: z.object({
    name: z.string().min(2),
    address: z.string().optional(),
    phone: z.string().optional(),
  }),
  owner: z.object({
    name: z.string().min(2),
    email: z.string().email(),
    password: z.string().min(8),
    phone: z.string().optional(),
  }),
});

const planSchema = z.object({
  name: z.string().min(1),
  duration_days: z.number().int().positive(),
  price: z.number().nonnegative(),
  sessions_per_day: z.literal(1).nullable().default(null),
  includes: z.record(z.boolean()).default({}),
  allowed_hours: z
    .string()
    .regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/)
    .nullable()
    .default(null),
  active: z.boolean().optional(),
});

const memberInfoSchema = z.object({
  full_name: z.string().min(2),
  phone: z.string().optional(),
  sex: z.enum(['male', 'female']).optional(),
  photo_url: z.string().nullable().optional(),
});

const enrollSchema = z.object({
  member: memberInfoSchema,
  descriptors: z.array(descriptor).max(5).default([]),
  plan_id: z.number().int().positive(),
  payment: z.object({
    amount: z.number().nonnegative().optional(),
    method: paymentMethod,
    note: z.string().optional(),
  }),
});

/**
 * A member back-filled from the gym's paper register. The dates are whatever
 * was written on the paper — `calendar` says which system they are in, and the
 * service converts them before anything is stored.
 */
const dateOnlyString = z.string().regex(/^\d{4}-\d{1,2}-\d{1,2}$/);
const previousMemberSchema = z.object({
  member: memberInfoSchema,
  descriptors: z.array(descriptor).max(5).default([]),
  plan_id: z.number().int().positive(),
  calendar: z.enum(['gregorian', 'ethiopian']),
  /** Provenance for the audit log; does not affect conversion. */
  entered_calendar: z.enum(['gregorian', 'ethiopian']).optional(),
  joined_at: dateOnlyString,
  starts_at: dateOnlyString,
  /** Omitted = start date + the plan's duration. */
  expires_at: dateOnlyString.optional(),
  /** Omitted = the money was taken before the system existed and is not being recorded. */
  payment: z
    .object({
      amount: z.number().nonnegative().optional(),
      method: paymentMethod,
      note: z.string().optional(),
    })
    .optional(),
});

/**
 * Admin correction of an existing member — a patch, so every key is optional
 * and an absent one means "leave it alone".
 *
 * Wider than `memberInfoSchema`: phone and sex are nullable here because
 * clearing a wrong value is as much a correction as typing a right one, and the
 * dates a member was created with are editable too. `subscription` rewrites the
 * member's current period in place; it never takes a payment.
 */
const memberUpdateSchema = z
  .object({
    full_name: z.string().min(2).optional(),
    phone: z.string().nullable().optional(),
    sex: z.enum(['male', 'female']).nullable().optional(),
    photo_url: z.string().nullable().optional(),
    joined_at: dateOnlyString.optional(),
    subscription: z
      .object({
        plan_id: z.number().int().positive().optional(),
        starts_at: dateOnlyString.optional(),
        expires_at: dateOnlyString.optional(),
      })
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

const renewSchema = z.object({
  plan_id: z.number().int().positive(),
  amount: z.number().nonnegative().optional(),
  method: paymentMethod,
  note: z.string().optional(),
});

const recognizeSchema = z
  .object({
    member_id: z.number().int().positive().optional(),
    guest_id: z.number().int().positive().optional(),
    descriptor: descriptor.optional(),
    confidence: z.number().optional(),
  })
  .refine((v) => v.member_id !== undefined || v.guest_id !== undefined || v.descriptor !== undefined, {
    message: 'member_id, guest_id or descriptor required',
  });

const guestSchema = z.object({
  name: z.string().min(2),
  descriptor: descriptor.nullable().optional(),
  valid_days: z.number().int().min(0).max(30).default(0),
});

const settingsSchema = z.object({
  name: z.string().min(2).optional(),
  address: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  telegram_bot_token: z.string().nullable().optional(),
  settings: z
    .object({
      grace_period_days: z.number().int().min(0),
      auto_checkout_hours: z.number().min(0.5),
      expiry_reminder_days: z.number().int().min(0),
      absence_nudge_days: z.number().int().min(1),
      match_threshold: z.number().min(0.2).max(0.9),
      closing_time: z.string().regex(/^\d{2}:\d{2}$/),
      entry_mode: z.enum(['auto', 'manual']),
      camera_enabled: z.boolean(),
    })
    .partial()
    .optional(),
});

// ---------- rate limits (per IP; trust proxy is set for Render) ----------
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20, // login/register attempts per 15 min
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — try again in a few minutes' },
});
const feedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10, // feedback mails per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too much feedback at once — try again later' },
});
/**
 * Far harder than the rest of the API: every verify attempt spends a paid
 * verification credit, so this is a cost-control boundary and not just abuse
 * prevention.
 */
const verifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification attempts — wait a minute and try again' },
});

/**
 * Receipt screenshots, held in memory and decoded in-process (never written to
 * disk, never forwarded anywhere).
 *
 * 6 MB is deliberately well under the body limit: the multipart envelope adds
 * the other form fields and boundaries on top of the file, and overshooting
 * makes the body get dropped BEFORE validation runs — which surfaces as a
 * baffling "no file was uploaded".
 */
const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    cb(null, ['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype));
  },
});

// ---------- auth ----------
// public: lets the landing/registration pages advertise an active free trial
api.get(
  '/auth/registration-mode',
  asyncHandler(async (_req, res) => {
    const { trial_mode, trial_days } = await platformModel.getSettings();
    res.json({ trial_mode, trial_days });
  }),
);
api.post('/auth/register-gym', authLimiter, validate(registerGymSchema), asyncHandler(auth.registerGym));
api.post(
  '/auth/login',
  authLimiter,
  validate(z.object({ email: z.string().email(), password: z.string() })),
  asyncHandler(auth.login),
);
api.post('/auth/refresh', validate(z.object({ refreshToken: z.string() })), asyncHandler(auth.refresh));
api.post('/auth/logout', validate(z.object({ refreshToken: z.string() })), asyncHandler(auth.logout));

// LAN camera stream proxy — authenticates via ?token= because <img>/<video>
// tags cannot send an Authorization header (registered before requireAuth).
api.get('/camera-proxy', asyncHandler(cameraProxy));

// ---------- platform super-admin (product owner) ----------
api.use('/admin', adminRouter);

// everything below requires a logged-in staff member of a non-frozen gym
api.use(requireAuth);
api.use(asyncHandler(blockFrozenGym));

// ---------- billing (deliberately NOT behind the paywall) ----------
// An unpaid gym is still signed in: it must be able to see what it owes and
// pay it. Everything after this block is gated on an active subscription.
const cycleSchema = z.enum(['MONTHLY', 'YEARLY']);
const onlineProvider = z.enum(['CBE', 'TELEBIRR']);

api.get('/billing', asyncHandler(billing.checkout));
api.get('/billing/payments', asyncHandler(billing.history));
api.post(
  '/billing/verify',
  verifyLimiter,
  requireOwner,
  validate(
    z.object({
      provider: onlineProvider,
      reference: z.string().min(4).max(200),
      planId: z.number().int().positive(),
      cycle: cycleSchema,
    }),
  ),
  asyncHandler(billing.verifyReference),
);
// multipart — validated inside the controller, since zod cannot see the file
api.post(
  '/billing/verify-screenshot',
  verifyLimiter,
  requireOwner,
  receiptUpload.single('file'),
  asyncHandler(billing.verifyScreenshot),
);

// ---------- platform feature notices (also NOT behind the paywall) ----------
// Two reasons this sits above the paywall: an unpaid gym is parked on
// /billing, where a "your camera was switched off" alert is still the truth it
// needs; and a 402 on this poll would be pure console noise on a page whose
// whole job is to clear the 402.
api.get('/features', asyncHandler(features.state));
api.post('/features/notices/:id/ack', asyncHandler(features.acknowledge));
api.post('/features/notices/ack-all', asyncHandler(features.acknowledgeAll));

api.use(asyncHandler(requireActiveSubscription));

// ---------- plans ----------
api.get('/plans', asyncHandler(plans.list));
api.post('/plans', validate(planSchema), asyncHandler(plans.create));
api.put('/plans/:id', validate(planSchema.partial()), asyncHandler(plans.update));
api.delete('/plans/:id', asyncHandler(plans.remove));

// ---------- members ----------
api.get('/members', asyncHandler(members.list));
api.get('/members/descriptors', requireFeature('camera'), asyncHandler(members.allDescriptors));
api.get('/members/descriptors/version', requireFeature('camera'), asyncHandler(members.descriptorsVersion));
api.get('/members/export', asyncHandler(members.exportData)); // before /members/:id
api.post('/members', validate(enrollSchema), asyncHandler(members.enroll));
api.post('/members/previous', validate(previousMemberSchema), asyncHandler(members.enrollPrevious));
api.get('/members/:id', asyncHandler(members.detail));
api.put('/members/:id', validate(memberUpdateSchema), asyncHandler(members.update));
api.post(
  '/members/:id/descriptors',
  requireFeature('camera'),
  validate(z.object({ descriptors: z.array(descriptor).min(1).max(5), replace: z.boolean().optional() })),
  asyncHandler(members.addDescriptors),
);
api.post('/members/:id/renew', validate(renewSchema), asyncHandler(members.renew));
// Removing someone is owner-only, like every other destructive action here.
// Archive keeps the payment history; DELETE is refused for anyone who has any.
api.post('/members/:id/archive', requireOwner, asyncHandler(members.archive));
api.post('/members/:id/restore', requireOwner, asyncHandler(members.restore));
api.delete('/members/:id', requireOwner, asyncHandler(members.remove));
api.post('/members/:id/freeze', asyncHandler(members.freeze));
api.post('/members/:id/unfreeze', asyncHandler(members.unfreeze));

// ---------- check-ins / monitor ----------
api.post('/check-ins/recognize', requireFeature('camera'), validate(recognizeSchema), asyncHandler(checkIns.recognize));
api.post(
  '/check-ins/override',
  validate(z.object({ member_id: z.number().int().positive() })),
  asyncHandler(checkIns.override),
);
api.post(
  '/check-ins/approve',
  validate(z.object({ member_id: z.number().int().positive() })),
  asyncHandler(checkIns.approve),
);
api.get('/check-ins/open', asyncHandler(checkIns.listOpen));
api.post('/check-ins/:id/checkout', asyncHandler(checkIns.checkout));
api.get('/occupancy', asyncHandler(checkIns.occupancy));
api.get('/events', asyncHandler(checkIns.recentEvents));

// ---------- guests (Phase 3) ----------
api.get('/guests', asyncHandler(guests.list));
api.get('/guests/descriptors', requireFeature('camera'), asyncHandler(guests.descriptors));
api.post('/guests', validate(guestSchema), asyncHandler(guests.create));
api.post('/guests/:id/expire', asyncHandler(guests.expire));
api.post(
  '/guests/:id/convert',
  validate(z.object({ member_id: z.number().int().positive() })),
  asyncHandler(guests.convert),
);

// ---------- audit log (Phase 3, owner only) ----------
api.get(
  '/audit-logs',
  requireOwner,
  asyncHandler(async (req, res) => {
    const result = await auditLogModel.list(req.auth.gymId, {
      entity: req.query.entity as string | undefined,
      action: req.query.action as string | undefined,
      ...pageParams(req),
    });
    res.json(pagedBody(req, result));
  }),
);

// ---------- telegram / notifications (Phase 2) ----------
api.post('/members/:id/telegram-link', requireFeature('telegram'), asyncHandler(telegram.memberLink));
api.post('/telegram/owner-link', requireFeature('telegram'), asyncHandler(telegram.ownerLink));
api.get('/telegram/status', asyncHandler(telegram.status));
api.get('/notifications', asyncHandler(telegram.notifications));

// ---------- payments / dashboard ----------
api.get('/payments', asyncHandler(payments.list));
api.get('/dashboard/stats', asyncHandler(dashboard.stats));
api.get('/dashboard/today', asyncHandler(dashboard.today));

// ---------- feedback (emailed to product owner) ----------
api.post(
  '/feedback',
  feedbackLimiter,
  validate(
    z.object({
      category: z.enum(['suggestion', 'bug', 'improvement', 'other']),
      subject: z.string().max(200).optional(),
      message: z.string().min(1).max(5000),
    }),
  ),
  asyncHandler(feedback.submit),
);

// ---------- settings / staff (owner only for writes) ----------
api.get('/settings', asyncHandler(settings.getGym));
api.put('/settings', requireOwner, validate(settingsSchema), asyncHandler(settings.updateGym));
api.get('/staff', asyncHandler(settings.listStaff));
api.post(
  '/staff',
  requireOwner,
  validate(
    z.object({
      name: z.string().min(2),
      email: z.string().email(),
      password: z.string().min(8),
      phone: z.string().optional(),
    }),
  ),
  asyncHandler(settings.createStaff),
);
api.delete('/staff/:id', requireOwner, asyncHandler(settings.removeStaff));
