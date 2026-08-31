import type { Knex } from 'knex';

/**
 * Short retention for the two noisiest log tables.
 *
 * `notifications` and `audit_logs` are now pruned to one week (see
 * jobs/index.ts). `notifications` had no prune at all and was the last
 * append-only table growing without bound against the 500 MB free tier.
 *
 * One thing depended on those rows surviving: the absence-nudge template
 * rotation counted a member's past `absence_nudge` rows to decide which
 * message to send next. A seven-day window would reset that counter every
 * week, so a long-absent member would receive the same first message forever.
 * The count moves onto the member row, where retention cannot touch it, and is
 * backfilled from the history that still exists at migration time.
 */

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE members
      ADD COLUMN absence_nudge_count INTEGER NOT NULL DEFAULT 0;

    UPDATE members m
      SET absence_nudge_count = c.n
      FROM (
        SELECT member_id, count(*)::int AS n
        FROM notifications
        WHERE type = 'absence_nudge' AND member_id IS NOT NULL
        GROUP BY member_id
      ) c
      WHERE c.member_id = m.id;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE members DROP COLUMN IF EXISTS absence_nudge_count;
  `);
}
