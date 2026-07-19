import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { env } from '../config/env';
import { unauthorized } from './errors';

export interface AccessPayload {
  sub: number; // user id (platform tokens: 0 = the owner, otherwise platform_admins.id)
  gymId: number; // 0 for the platform admin
  role: 'owner' | 'staff' | 'platform';
  name: string;
}

/**
 * Platform session token (longer-lived; no refresh flow). sub 0 is the
 * product owner (env credentials); any other sub is a platform_admins row —
 * verified against the DB on every request so removal is instant.
 */
export function signPlatformToken(adminId = 0, name = 'Platform Owner'): string {
  const payload: AccessPayload = { sub: adminId, gymId: 0, role: 'platform', name };
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
