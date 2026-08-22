import type { Knex } from 'knex';
import { db } from '../db/knex';

export interface AuditLogRow {
  id: number;
  gym_id: number;
  user_id: number | null;
  user_name: string | null;
  action: string;
  entity: string;
  entity_id: number | null;
  meta: Record<string, unknown>;
  created_at: Date;
}

export async function list(
  gymId: number,
  filter: { entity?: string; action?: string } = {},
  limit = 200,
): Promise<AuditLogRow[]> {
  const q = db('audit_logs as a')
    .leftJoin('users as u', 'u.id', 'a.user_id')
    .where('a.gym_id', gymId)
    .select('a.*', 'u.name as user_name')
    .orderBy('a.created_at', 'desc')
    .limit(limit);
  if (filter.entity) q.andWhere('a.entity', filter.entity);
  if (filter.action) q.andWhereILike('a.action', `%${filter.action}%`);
  return q;
}

/** See eventModel.PURGE_BATCH — same reasoning. */
const PURGE_BATCH = 5_000;

/**
 * Retention prune (daily job).
 *
 * `list` above serves at most the newest 200 rows per gym and has no
 * pagination, so older rows cannot be displayed. The window is kept long
 * (a year) anyway: audit rows answer "who changed this member", and that is
 * worth more than the ~1.4 MB/gym/year it costs.
 */
export async function purgeOlderThan(days: number): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = await db('audit_logs')
      .whereIn(
        'id',
        db('audit_logs')
          .select('id')
          .where('created_at', '<', db.raw("now() - ? * interval '1 day'", [days]))
          .limit(PURGE_BATCH),
      )
      .del();
    total += deleted;
    if (deleted < PURGE_BATCH) return total;
  }
}

export async function log(
  data: {
    gym_id: number;
    user_id: number | null;
    action: string;
    entity: string;
    entity_id?: number | null;
    meta?: Record<string, unknown>;
  },
  trx: Knex = db,
): Promise<void> {
  await trx('audit_logs').insert({ ...data, meta: JSON.stringify(data.meta ?? {}) });
}
