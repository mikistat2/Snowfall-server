import { db } from '../db/knex';

export interface RefreshTokenRow {
  id: number;
  user_id: number;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
}

export async function create(userId: number, tokenHash: string, expiresAt: Date): Promise<void> {
  await db('refresh_tokens').insert({ user_id: userId, token_hash: tokenHash, expires_at: expiresAt });
}

export async function findValid(tokenHash: string): Promise<RefreshTokenRow | undefined> {
  return db('refresh_tokens')
    .where({ token_hash: tokenHash })
    .whereNull('revoked_at')
    .where('expires_at', '>', db.fn.now())
    .first();
}

export async function revoke(tokenHash: string): Promise<void> {
  await db('refresh_tokens').where({ token_hash: tokenHash }).update({ revoked_at: db.fn.now() });
}

/**
 * Kill every session of one account.
 *
 * A hard DELETE of the user used to do this implicitly (refresh_tokens
 * cascades from users). Removal is now a tombstone, so the sessions have to be
 * revoked by hand — otherwise a removed employee's phone keeps refreshing its
 * way back in for the full refresh-token lifetime.
 */
export async function revokeAllForUser(userId: number): Promise<number> {
  return db('refresh_tokens')
    .where({ user_id: userId })
    .whereNull('revoked_at')
    .update({ revoked_at: db.fn.now() });
}
