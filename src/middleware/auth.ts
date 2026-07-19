import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, type AccessPayload } from '../utils/jwt';
import { forbidden, unauthorized } from '../utils/errors';
import * as gymModel from '../models/gymModel';
import * as platformAdminModel from '../models/platformAdminModel';
import type { PlatformAdminPerms } from '../models/platformAdminModel';

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
  if (gym.status === 'frozen') {
    throw forbidden('This gym account has been frozen by the platform. Please contact support.', 'GYM_FROZEN');
  }
  if (gym.status === 'pending') {
    throw forbidden('This gym registration has not been approved yet.', 'GYM_PENDING');
  }
  next();
}
