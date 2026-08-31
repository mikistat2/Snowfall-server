import type { Knex } from 'knex';

/**
 * Makes expiry reminders survive a sleeping server.
 *
 * The job matched an exact day (`daysLeft === expiry_reminder_days`), so a run
 * that did not happen — Render's free instance is asleep, a deploy restarted
 * the process, the box crashed — skipped that member permanently: the day
 * passed and the condition never matched again.
 *
 * The fix is to match a threshold and remember what was already sent. Where
 * that memory lives matters: `notifications` is pruned after seven days, so a
 * dedupe read from it would let a lapsed member be told again every week,
 * forever. It lives on the subscription instead, which is also exactly the
 * right grain — a renewal writes a new subscription row, so the new period
 * starts with a clean set of milestones and no explicit reset is needed.
 *
 * Three milestones per period, each fired at most once:
 *   ahead  — N days before expiry
 *   due    — expiry day
 *   grace  — the day after, when the grace period starts
 *
 * `platform_settings.daily_tasks_ran_on` is the other half: with the work now
 * triggerable over HTTP as well as by cron, it is the day-claim that stops two
 * triggers on the same day from sending everything twice.
 */

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE subscriptions
      ADD COLUMN reminded_ahead_at TIMESTAMPTZ,
      ADD COLUMN reminded_due_at   TIMESTAMPTZ,
      ADD COLUMN reminded_grace_at TIMESTAMPTZ;

    ALTER TABLE platform_settings
      ADD COLUMN daily_tasks_ran_on DATE;
  `);

  /**
   * Backfill from the notification history, which is still intact at migration
   * time (the weekly prune is a cron job, not part of any migration).
   *
   * Without this, every member already inside the reminder window on the day
   * this ships would be told a second time. `days_left` distinguishes the two
   * milestones that share the `expiry_reminder` type; it is read through a
   * regex guard because a malformed payload must not abort the migration.
   */
  await knex.raw(`
    WITH latest AS (
      SELECT DISTINCT ON (member_id) id, member_id
      FROM subscriptions
      ORDER BY member_id, expires_at DESC
    ),
    parsed AS (
      SELECT
        n.member_id,
        n.type,
        n.sent_at,
        CASE WHEN n.payload->>'days_left' ~ '^-?[0-9]+$'
             THEN (n.payload->>'days_left')::int END AS days_left
      FROM notifications n
      WHERE n.member_id IS NOT NULL
        AND n.type IN ('expiry_reminder', 'expired')
    ),
    seen AS (
      SELECT
        member_id,
        max(sent_at) FILTER (WHERE type = 'expiry_reminder' AND days_left > 0)  AS ahead_at,
        max(sent_at) FILTER (WHERE type = 'expiry_reminder' AND days_left <= 0) AS due_at,
        max(sent_at) FILTER (WHERE type = 'expired')                            AS grace_at
      FROM parsed
      GROUP BY member_id
    )
    UPDATE subscriptions s
      SET reminded_ahead_at = seen.ahead_at,
          reminded_due_at   = seen.due_at,
          reminded_grace_at = seen.grace_at
      FROM latest, seen
      WHERE s.id = latest.id AND seen.member_id = latest.member_id;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE subscriptions
      DROP COLUMN IF EXISTS reminded_ahead_at,
      DROP COLUMN IF EXISTS reminded_due_at,
      DROP COLUMN IF EXISTS reminded_grace_at;
    ALTER TABLE platform_settings DROP COLUMN IF EXISTS daily_tasks_ran_on;
  `);
}
