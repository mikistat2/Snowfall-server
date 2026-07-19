import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler } from '../utils/async';
import { validate } from '../middleware/validate';
import { requirePlatformAdmin, requirePlatformOwner, requirePlatformPerm } from '../middleware/auth';
import * as admin from '../controllers/platformAdminController';

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
adminRouter.post('/gyms/:id/renew', requirePlatformPerm('renew'), asyncHandler(admin.renewGym));
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
adminRouter.delete(
  '/gyms/:id',
  requirePlatformOwner,
  validate(z.object({ confirm_name: z.string(), note: z.string().max(1000).optional() })),
  asyncHandler(admin.deleteGym),
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
