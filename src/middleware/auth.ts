import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, type AccessPayload } from '../utils/jwt';
import { forbidden, unauthorized } from '../utils/errors';

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
