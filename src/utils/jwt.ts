import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { env } from '../config/env';
import { unauthorized } from './errors';

export interface AccessPayload {
  sub: number; // user id (0 for the platform admin)
  gymId: number; // 0 for the platform admin
  role: 'owner' | 'staff' | 'platform';
  name: string;
}

/** Platform super-admin session token (longer-lived; no refresh flow). */
export function signPlatformToken(): string {
  const payload: AccessPayload = { sub: 0, gymId: 0, role: 'platform', name: 'Platform Admin' };
  return jwt.sign(payload, env.jwt.accessSecret, { expiresIn: '12h' });
}

export function signAccessToken(payload: AccessPayload): string {
  return jwt.sign(payload, env.jwt.accessSecret, {
    expiresIn: env.jwt.accessTtl as jwt.SignOptions['expiresIn'],
  });
}

export function verifyAccessToken(token: string): AccessPayload {
  try {
    return jwt.verify(token, env.jwt.accessSecret) as unknown as AccessPayload;
  } catch {
    throw unauthorized('Invalid or expired access token');
  }
}

/** Opaque refresh tokens: random 256-bit value, stored hashed (sha256). */
export function generateRefreshToken(): { token: string; hash: string; expiresAt: Date } {
  const token = crypto.randomBytes(32).toString('hex');
  return {
    token,
    hash: hashRefreshToken(token),
    expiresAt: new Date(Date.now() + env.jwt.refreshTtlDays * 24 * 60 * 60 * 1000),
  };
}

export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
