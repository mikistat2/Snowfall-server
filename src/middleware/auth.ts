import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, type AccessPayload } from '../utils/jwt';
import { forbidden, unauthorized } from '../utils/errors';
import * as gymModel from '../models/gymModel';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth: AccessPayload;
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

export function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized('Missing bearer token');
  const payload = verifyAccessToken(header.slice(7));
  if (payload.role !== 'platform') throw forbidden('Platform admin required');
  req.auth = payload;
  next();
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
