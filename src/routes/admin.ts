import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler } from '../utils/async';
import { validate } from '../middleware/validate';
import { requirePlatformAdmin } from '../middleware/auth';
import * as admin from '../controllers/platformAdminController';

/**
 * Platform super-admin API (the product owner managing tenant gyms).
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

adminRouter.use(requirePlatformAdmin);

adminRouter.get('/overview', asyncHandler(admin.overview));
adminRouter.get('/settings', asyncHandler(admin.getSettings));
adminRouter.put(
  '/settings',
  validate(
    z
      .object({ trial_mode: z.boolean(), trial_days: z.number().int().min(1).max(365) })
      .partial(),
  ),
  asyncHandler(admin.updateSettings),
);
adminRouter.get('/gyms', asyncHandler(admin.listGyms));
adminRouter.get('/export', asyncHandler(admin.exportAllMembers));
adminRouter.get('/gyms/:id/export', asyncHandler(admin.exportGymMembers));
adminRouter.post('/gyms/:id/approve', asyncHandler(admin.approveGym));
adminRouter.post('/gyms/:id/renew', asyncHandler(admin.renewGym));
adminRouter.get('/gyms/:id', asyncHandler(admin.gymDetail));
adminRouter.post(
  '/gyms/:id/freeze',
  validate(z.object({ note: z.string().max(1000).optional() })),
  asyncHandler(admin.freezeGym),
);
adminRouter.post('/gyms/:id/unfreeze', asyncHandler(admin.unfreezeGym));
adminRouter.put(
  '/gyms/:id/note',
  validate(z.object({ note: z.string().max(1000).nullable() })),
  asyncHandler(admin.updateNote),
);
adminRouter.delete(
  '/gyms/:id',
  validate(z.object({ confirm_name: z.string(), note: z.string().max(1000).optional() })),
  asyncHandler(admin.deleteGym),
);
