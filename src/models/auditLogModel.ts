import type { Knex } from 'knex';
import { db } from '../db/knex';
import type { Paged } from '../types';

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

export interface AuditFilter {
  entity?: string;
  action?: string;
  page?: number;
  pageSize?: number;
}

/**
 * Newest first, one page at a time.
 *
 * `created_at` alone is not a total order — several rows written inside one
 * request share a timestamp, and Postgres is free to return those in any order,
 * which at a page boundary shows a row twice or skips it. `id` breaks the tie.
 *
 * The join to `users` is on the row query only. It cannot change the row count
 * (`user_id` is a single nullable FK), so making COUNT pay for it would be
 * waste on the one query that runs against every matching row.
 */
export async function list(gymId: number, filter: AuditFilter = {}): Promise<Paged<AuditLogRow>> {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filter.pageSize ?? 25));

  const base = db('audit_logs as a').where('a.gym_id', gymId);
  if (filter.entity) base.andWhere('a.entity', filter.entity);
  if (filter.action) base.andWhereILike('a.action', `%${filter.action}%`);

  const [countRow] = await base.clone().count<{ count: string }[]>('a.id as count');
  const total = Number(countRow?.count ?? 0);

  const rows = await base
    .clone()
    .leftJoin('users as u', 'u.id', 'a.user_id')
    .select('a.*', 'u.name as user_name')
    .orderBy([
      { column: 'a.created_at', order: 'desc' },
      { column: 'a.id', order: 'desc' },
    ])
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return { rows, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

/** See eventModel.PURGE_BATCH — same reasoning. */
const PURGE_BATCH = 5_000;

/**
 * Retention prune (daily job).
 *
 * `list` above serves at most the newest 200 rows per gym and has no
 * pagination, so older rows cannot be displayed. The window is set in
 * jobs/index.ts and is now a week — short enough that these rows no longer
 * answer "who changed this member last month". See the note there before
 * relying on this table for anything older.
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
