import type { Knex } from 'knex';
import { db } from '../db/knex';
import type { Severity } from '../types';

export interface EventRow {
  id: number;
  gym_id: number;
  type: string;
  severity: Severity;
  message: string;
  member_id: number | null;
  created_at: Date;
}

export async function create(
  data: { gym_id: number; type: string; severity: Severity; message: string; member_id?: number | null },
  trx: Knex = db,
): Promise<EventRow> {
  const [row] = await trx('events').insert(data).returning('*');
  return row;
}

export async function listRecent(gymId: number, limit = 50): Promise<EventRow[]> {
  return db('events').where({ gym_id: gymId }).orderBy('created_at', 'desc').limit(limit);
}

/** Rows per DELETE statement, so a first prune of a year's backlog never
 *  holds one long transaction on a 0.25 CU compute. */
const PURGE_BATCH = 5_000;

/**
 * Retention prune (daily job).
 *
 * `listRecent` above is the ONLY read of this table, and it serves the newest
 * 50 rows per gym. Anything older is unreachable from the UI and exists purely
 * to consume the 0.5 GB of free-tier storage — this table is the single
 * biggest contributor to per-gym growth (~4.8 MB/gym/year).
 *
 * Deleted in batches, newest-cutoff first, so the statement stays short.
 */
export async function purgeOlderThan(days: number): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = await db('events')
      .whereIn(
        'id',
        db('events')
          .select('id')
          .where('created_at', '<', db.raw("now() - ? * interval '1 day'", [days]))
          .limit(PURGE_BATCH),
      )
      .del();
    total += deleted;
    if (deleted < PURGE_BATCH) return total;
  }
}
