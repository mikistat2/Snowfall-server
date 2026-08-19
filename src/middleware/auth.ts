import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, type AccessPayload } from '../utils/jwt';
import { AppError, forbidden, unauthorized } from '../utils/errors';
import * as gymModel from '../models/gymModel';
import * as billingModel from '../models/billingModel';
import * as billingService from '../services/billingService';
import * as platformAdminModel from '../models/platformAdminModel';
import type { PlatformAdminPerms } from '../models/platformAdminModel';
import type { GymRow } from '../types';

export interface PlatformAuth {
  /** true only for the product owner (env credentials) — full access. */
  isOwner: boolean;
  adminId: number; // 0 for the owner
  name: string;
  permissions: PlatformAdminPerms;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth: AccessPayload;
      /** Set by blockFrozenGym so requireActiveSubscription need not refetch. */
      gym?: GymRow;
      platform?: PlatformAuth;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized('Missing bearer token');
  req.auth = verifyAccessToken(header.slice(7));
  next();
}

export function requireOwner(req: Request, _res: Response, next: NextFunction): void {
  if (req.auth.role !== 'owner') throw forbidden('Owner role required');
  next();
}

/**
 * Platform panel guard. The owner (sub 0) authenticates purely by token;
 * sub-admins are re-checked against platform_admins on every request, so
 * removing one (or editing their permissions) takes effect immediately.
 */
export async function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized('Missing bearer token');
  const payload = verifyAccessToken(header.slice(7));
  if (payload.role !== 'platform') throw forbidden('Platform admin required');
  req.auth = payload;
  if (payload.sub === 0) {
    req.platform = {
      isOwner: true,
      adminId: 0,
      name: payload.name,
      permissions: { approve: true, freeze: true, renew: true, export: true },
    };
  } else {
    const admin = await platformAdminModel.findById(payload.sub);
    if (!admin) throw unauthorized('Your admin access has been revoked');
    req.platform = {
      isOwner: false,
      adminId: admin.id,
      name: admin.name,
      permissions: platformAdminModel.toPublic(admin).permissions,
    };
  }
  next();
}

/** Owner-only platform routes: delete gym, settings, admin management. */
export function requirePlatformOwner(req: Request, _res: Response, next: NextFunction): void {
  if (!req.platform?.isOwner) throw forbidden('Only the platform owner can do this');
  next();
}

/** Permission-gated platform routes (always granted to the owner). */
export function requirePlatformPerm(perm: keyof PlatformAdminPerms) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.platform?.permissions[perm]) {
      throw forbidden('The platform owner has not granted you this permission');
    }
    next();
  };
}

/**
 * Blocks every tenant API call once the platform admin freezes the gym.
 * One indexed PK lookup per request — negligible at this scale.
 */
export async function blockFrozenGym(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const gym = await gymModel.findById(req.auth.gymId);
  if (!gym) throw unauthorized('Gym no longer exists');
  req.gym = gym;
  if (gym.status === 'frozen') {
    throw forbidden('This gym account has been frozen by the platform. Please contact support.', 'GYM_FROZEN');
  }
  if (gym.status === 'pending') {
    throw forbidden('This gym registration has not been approved yet.', 'GYM_PENDING');
  }
  next();
}

/**
 * The paywall. Returns **402** with a machine-readable code — not 401 or 403,
 * which the client already spends on "log in again" and "you are frozen".
 *
 * Staff of an unpaid gym are still signed in and can reach /billing, /auth
 * and their own profile; they just cannot reach anything that costs us money
 * to run. The billing routes are registered before this middleware for exactly
 * that reason.
 *
 * The decision itself lives in billingService.hasAccess, which the client's
 * checkout payload also reports, so the two can never disagree.
 */
export async function requireActiveSubscription(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const settings = await billingModel.getSettings();
  if (!settings.payments_required) return next();
  // blockFrozenGym already loaded (and validated) this row earlier in the
  // chain — reuse it rather than paying a second Neon round-trip per request.
  const gym = req.gym ?? (await gymModel.findById(req.auth.gymId));
  if (!gym) throw unauthorized('Gym no longer exists');
  if (billingService.hasAccess(gym, settings)) return next();

  throw new AppError(
    402,
    gym.subscription_ends_at
      ? 'Your subscription has expired. Renew it to continue using the system.'
      : 'Your gym does not have an active subscription yet. Pay to activate it.',
    'PAYMENT_REQUIRED',
  );
}
