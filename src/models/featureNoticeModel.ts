import { db } from '../db/knex';
import type { FeatureKey, FeatureNoticeRow } from '../types';

/** See the 20260826000009 migration for why this table exists. */

export async function create(data: {
  gym_id: number;
  feature: FeatureKey;
  allowed: boolean;
  note?: string | null;
  changed_by?: string | null;
}): Promise<FeatureNoticeRow> {
  const [row] = await db('gym_feature_notices')
    .insert({
      gym_id: data.gym_id,
      feature: data.feature,
      allowed: data.allowed,
      note: data.note?.trim() || null,
      changed_by: data.changed_by ?? null,
    })
    .returning('*');
  return row;
}

/** Unseen notices, oldest first — the alert walks them in the order they happened. */
export async function listPending(gymId: number): Promise<FeatureNoticeRow[]> {
  return db('gym_feature_notices')
    .where({ gym_id: gymId })
    .whereNull('acknowledged_at')
    .orderBy('created_at', 'asc');
}

/** Everything that ever happened to this gym's features, newest first. */
export async function listRecent(gymId: number, limit = 20): Promise<FeatureNoticeRow[]> {
  return db('gym_feature_notices')
    .where({ gym_id: gymId })
    .orderBy('created_at', 'desc')
    .limit(limit);
}

/**
 * Marks one notice seen. Scoped by gym as well as id so a guessed id from
 * another tenant cannot be acknowledged — the route is authenticated, but the
 * id itself is not a secret.
 *
 * Already-acknowledged rows are left alone rather than re-stamped: the first
 * person to see it is the one worth recording.
 */
export async function acknowledge(gymId: number, id: number, userId: number | null): Promise<boolean> {
  const count = await db('gym_feature_notices')
    .where({ id, gym_id: gymId })
    .whereNull('acknowledged_at')
    .update({ acknowledged_at: new Date(), acknowledged_by: userId });
  return count > 0;
}

/** Dismiss everything pending in one go (the alert's "Got it" on the last card). */
export async function acknowledgeAll(gymId: number, userId: number | null): Promise<number> {
  return db('gym_feature_notices')
    .where({ gym_id: gymId })
    .whereNull('acknowledged_at')
    .update({ acknowledged_at: new Date(), acknowledged_by: userId });
}
