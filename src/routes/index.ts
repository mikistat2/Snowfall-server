import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler } from '../utils/async';
import { validate } from '../middleware/validate';
import { requireAuth, requireOwner, blockFrozenGym } from '../middleware/auth';
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
import * as auditLogModel from '../models/auditLogModel';
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

// ---------- auth ----------
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

// ---------- plans ----------
api.get('/plans', asyncHandler(plans.list));
api.post('/plans', validate(planSchema), asyncHandler(plans.create));
api.put('/plans/:id', validate(planSchema.partial()), asyncHandler(plans.update));
api.delete('/plans/:id', asyncHandler(plans.remove));

// ---------- members ----------
api.get('/members', asyncHandler(members.list));
api.get('/members/descriptors', asyncHandler(members.allDescriptors));
api.get('/members/export', asyncHandler(members.exportData)); // before /members/:id
api.post('/members', validate(enrollSchema), asyncHandler(members.enroll));
api.get('/members/:id', asyncHandler(members.detail));
api.put('/members/:id', validate(memberInfoSchema.partial()), asyncHandler(members.update));
api.post(
  '/members/:id/descriptors',
  validate(z.object({ descriptors: z.array(descriptor).min(1).max(5), replace: z.boolean().optional() })),
  asyncHandler(members.addDescriptors),
);
api.post('/members/:id/renew', validate(renewSchema), asyncHandler(members.renew));
api.post('/members/:id/freeze', asyncHandler(members.freeze));
api.post('/members/:id/unfreeze', asyncHandler(members.unfreeze));

// ---------- check-ins / monitor ----------
api.post('/check-ins/recognize', validate(recognizeSchema), asyncHandler(checkIns.recognize));
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
api.get('/guests/descriptors', asyncHandler(guests.descriptors));
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
    res.json(
      await auditLogModel.list(req.auth.gymId, {
        entity: req.query.entity as string | undefined,
        action: req.query.action as string | undefined,
      }),
    );
  }),
);

// ---------- telegram / notifications (Phase 2) ----------
api.post('/members/:id/telegram-link', asyncHandler(telegram.memberLink));
api.post('/telegram/owner-link', asyncHandler(telegram.ownerLink));
api.get('/telegram/status', asyncHandler(telegram.status));
api.get('/notifications', asyncHandler(telegram.notifications));

// ---------- payments / dashboard ----------
api.get('/payments', asyncHandler(payments.list));
api.get('/dashboard/stats', asyncHandler(dashboard.stats));

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
