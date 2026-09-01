import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler } from '../utils/async';
import { validate } from '../middleware/validate';
import { requirePlatformAdmin, requirePlatformOwner, requirePlatformPerm } from '../middleware/auth';
import * as admin from '../controllers/platformAdminController';
import * as billing from '../controllers/platformBillingController';

/**
 * Platform admin API. Two levels of access:
 *  - the OWNER (env credentials): everything, including gym deletion,
 *    platform settings and managing sub-admins;
 *  - SUB-ADMINS (platform_admins table): read the dashboard, plus whatever
 *    per-account permissions the owner granted (approve/freeze/renew/export).
 *    They can never delete gyms — there is no permission for it.
 * Authenticated with a dedicated 'platform' JWT — completely separate from
 * gym staff accounts.
 */
export const adminRouter = Router();

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — try again in a few minutes' },
});

adminRouter.post(
  '/login',
  adminLoginLimiter,
  validate(z.object({ email: z.string().email(), password: z.string().min(1) })),
  asyncHandler(admin.login),
);

adminRouter.use(asyncHandler(requirePlatformAdmin));

// readable by every platform admin
adminRouter.get('/me', asyncHandler(admin.me));
adminRouter.get('/overview', asyncHandler(admin.overview));
adminRouter.get('/gyms', asyncHandler(admin.listGyms));
adminRouter.get('/gyms/:id', asyncHandler(admin.gymDetail));
adminRouter.put(
  '/gyms/:id/note',
  validate(z.object({ note: z.string().max(1000).nullable() })),
  asyncHandler(admin.updateNote),
);

// permission-gated (the owner always passes)
adminRouter.post('/gyms/:id/approve', requirePlatformPerm('approve'), asyncHandler(admin.approveGym));
adminRouter.post(
  '/gyms/:id/renew',
  requirePlatformPerm('renew'),
  // Body is optional: no body at all still means "+1 year", as it always did.
  validate(
    z
      .object({ cycle: z.enum(['MONTHLY', 'YEARLY']), fromNow: z.boolean() })
      .partial()
      .default({}),
  ),
  asyncHandler(admin.renewGym),
);
// The undo for the route above. Shares the `renew` permission because it is
// the same authority — moving a gym's subscription end date around.
adminRouter.post(
  '/gyms/:id/trial',
  requirePlatformPerm('renew'),
  // Capped at a year: anything longer is a subscription, and should be granted
  // as one so the billing side reports it honestly.
  validate(z.object({ days: z.number().int().min(1).max(365).default(30) }).default({})),
  asyncHandler(admin.setTrial),
);
adminRouter.post(
  '/gyms/:id/freeze',
  requirePlatformPerm('freeze'),
  validate(z.object({ note: z.string().max(1000).optional() })),
  asyncHandler(admin.freezeGym),
);
adminRouter.post('/gyms/:id/unfreeze', requirePlatformPerm('freeze'), asyncHandler(admin.unfreezeGym));
adminRouter.get('/export', requirePlatformPerm('export'), asyncHandler(admin.exportAllMembers));
adminRouter.get('/gyms/:id/export', requirePlatformPerm('export'), asyncHandler(admin.exportGymMembers));

// owner-only: settings, gym deletion, sub-admin management
adminRouter.get('/settings', requirePlatformOwner, asyncHandler(admin.getSettings));
adminRouter.put(
  '/settings',
  requirePlatformOwner,
  validate(
    z
      .object({ trial_mode: z.boolean(), trial_days: z.number().int().min(1).max(365) })
      .partial(),
  ),
  asyncHandler(admin.updateSettings),
);
// Feature entitlements. Owner-only, matching the other structural switches
// (platform settings, comped status, gym deletion) rather than the
// day-to-day permissions granted to sub-admins.
adminRouter.put(
  '/gyms/:id/features',
  requirePlatformOwner,
  validate(
    // `note` reaches the gym owner verbatim — in the app, in Telegram and by
    // email — so it is the difference between a feature vanishing and a
    // feature being explained. Optional, but the panel always asks for one.
    z
      .object({
        camera_allowed: z.boolean(),
        telegram_allowed: z.boolean(),
        note: z.string().max(1000),
      })
      .partial()
      .refine((v) => v.camera_allowed !== undefined || v.telegram_allowed !== undefined, {
        message: 'Nothing to update',
      }),
  ),
  asyncHandler(admin.setFeatures),
);
adminRouter.delete(
  '/gyms/:id',
  requirePlatformOwner,
  validate(z.object({ confirm_name: z.string(), note: z.string().max(1000).optional() })),
  asyncHandler(admin.deleteGym),
);

// ---------------------------------------------------------------- billing --
// Subscription billing: the master switch, our prices and payment accounts,
// and every verification attempt made by any gym. Settings and plans are
// owner-only (they decide who pays what); the attempts table and manual
// payment recording follow the existing `renew` permission.

const cycleSchema = z.enum(['MONTHLY', 'YEARLY']);

adminRouter.get('/billing/settings', requirePlatformOwner, asyncHandler(billing.getSettings));
adminRouter.put(
  '/billing/settings',
  requirePlatformOwner,
  validate(
    z
      .object({
        payments_required: z.boolean(),
        cbe_enabled: z.boolean(),
        cbe_account_number: z.string().max(64).nullable(),
        cbe_account_name: z.string().max(200).nullable(),
        telebirr_enabled: z.boolean(),
        telebirr_phone: z.string().max(32).nullable(),
        telebirr_account_name: z.string().max(200).nullable(),
        currency: z.string().min(1).max(8),
        receipt_max_age_days: z.number().int().min(1).max(365),
        grace_days: z.number().int().min(0).max(90),
        instructions: z.string().max(4000).nullable(),
      })
      .partial(),
  ),
  asyncHandler(billing.updateSettings),
);

const planBody = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).nullable().optional(),
  monthly_price: z.number().nonnegative(),
  yearly_price: z.number().nonnegative(),
  currency: z.string().min(1).max(8).optional(),
  sort_order: z.number().int().min(0).max(999).optional(),
  is_active: z.boolean().optional(),
  // What the package includes. `member_limit` is null for unlimited, matching
  // the column; the CHECK constraint refuses zero and negatives.
  camera: z.boolean().optional(),
  telegram: z.boolean().optional(),
  member_limit: z.number().int().positive().nullable().optional(),
  setup_fee: z.number().nonnegative().optional(),
});
adminRouter.get('/billing/plans', requirePlatformOwner, asyncHandler(billing.listPlans));
adminRouter.post('/billing/plans', requirePlatformOwner, validate(planBody), asyncHandler(billing.createPlan));
adminRouter.put(
  '/billing/plans/:id',
  requirePlatformOwner,
  validate(planBody.partial()),
  asyncHandler(billing.updatePlan),
);
adminRouter.delete('/billing/plans/:id', requirePlatformOwner, asyncHandler(billing.removePlan));

adminRouter.get('/billing/payments', asyncHandler(billing.listAttempts));
adminRouter.post(
  '/gyms/:id/record-payment',
  requirePlatformPerm('renew'),
  validate(
    z.object({
      planId: z.number().int().positive().nullable().default(null),
      cycle: cycleSchema,
      amount: z.number().nonnegative(),
      provider: z.enum(['CASH', 'CBE', 'TELEBIRR']).default('CASH'),
      note: z.string().min(1).max(1000),
      /** Omitted → the server starts trials today and stacks everyone else. */
      startNow: z.boolean().optional(),
    }),
  ),
  asyncHandler(billing.recordPayment),
);
adminRouter.put(
  '/gyms/:id/comped',
  requirePlatformOwner,
  validate(z.object({ comped: z.boolean() })),
  asyncHandler(billing.setComped),
);

const permsSchema = z.object({
  approve: z.boolean(),
  freeze: z.boolean(),
  renew: z.boolean(),
  export: z.boolean(),
});
adminRouter.get('/admins', requirePlatformOwner, asyncHandler(admin.listAdmins));
adminRouter.post(
  '/admins',
  requirePlatformOwner,
  validate(
    z.object({
      name: z.string().min(1).max(100),
      email: z.string().email(),
      password: z.string().min(8).max(100),
      permissions: permsSchema,
    }),
  ),
  asyncHandler(admin.createAdmin),
);
adminRouter.put(
  '/admins/:id',
  requirePlatformOwner,
  validate(
    z
      .object({
        name: z.string().min(1).max(100),
        password: z.string().min(8).max(100),
        permissions: permsSchema.partial(),
      })
      .partial(),
  ),
  asyncHandler(admin.updateAdmin),
);
adminRouter.delete('/admins/:id', requirePlatformOwner, asyncHandler(admin.removeAdmin));
