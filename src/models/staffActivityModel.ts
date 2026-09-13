import { db } from '../db/knex';

/**
 * Per-person, per-day usage counts. See the 20260913000018 migration.
 *
 * Writes come only from staffActivityService, which decides when a write is
 * needed; reads come from the platform panel.
 */

export type ActivitySource = 'app' | 'web';

/**
 * How the caller classified this moment of activity:
 *  - 'new'      the process saw this person's previous request 30+ minutes ago
 *  - 'continue' the process saw them within the last 30 minutes
 *  - 'unknown'  the process has no memory of them (it restarted, or this is
 *               their first request since boot) — the stored last_seen_at
 *               decides instead
 */
export type VisitMode = 'new' | 'continue' | 'unknown';

/** Minutes of silence after which returning counts as a fresh visit. */
export const VISIT_GAP_MINUTES = 30;

/**
 * Today in Addis Ababa, computed by Postgres. SQL rather than JS so the day
 * cannot depend on the host's clock settings — Render is UTC, and Ethiopia
 * does not observe daylight saving, so the named zone is exact all year.
 */
export const ADDIS_TODAY = "(now() AT TIME ZONE 'Africa/Addis_Ababa')::date";

/**
 * Record activity for one person. A single statement, so two requests racing
 * through a fresh process cannot both count a visit: the row lock on the
 * conflicting key serialises them, and the second sees the first's
 * `last_seen_at`.
 *
 * The first write of a day always inserts with visits = 1 — opening the app
 * on a new day is a visit, whatever happened the night before.
 */
export async function touch(
  userId: number,
  gymId: number,
  source: ActivitySource,
  mode: VisitMode,
): Promise<void> {
  await db.raw(
    `
    INSERT INTO staff_activity_days (user_id, gym_id, day, source)
    VALUES (?, ?, ${ADDIS_TODAY}, ?)
    ON CONFLICT (user_id, day, source) DO UPDATE SET
      visits = staff_activity_days.visits + CASE
        WHEN ? = 'new' THEN 1
        WHEN ? = 'continue' THEN 0
        WHEN staff_activity_days.last_seen_at < now() - (? * interval '1 minute') THEN 1
        ELSE 0
      END,
      last_seen_at = now()
  `,
    [userId, gymId, source, mode, mode, VISIT_GAP_MINUTES],
  );
}

/** Retention: usage older than `days` is dropped by the maintenance job. */
export async function purgeOlderThan(days: number): Promise<number> {
  const result = await db.raw(
    `DELETE FROM staff_activity_days WHERE day < ${ADDIS_TODAY} - (? * interval '1 day')`,
    [days],
  );
  return result.rowCount ?? 0;
}

export interface ActivityDay {
  /** "YYYY-MM-DD", Addis calendar day. */
  day: string;
  visits: number;
  app_visits: number;
  web_visits: number;
  /** Distinct staff who opened the app or site that day. */
  active_staff: number;
  /** Members created that day, whatever date they were back-dated to. */
  members_added: number;
}

/**
 * One gym's last `days` days, oldest first, with a row for every day — a
 * quiet day is exactly the thing worth seeing, so it must not vanish from the
 * table just because nothing was recorded.
 */
export async function recentDays(gymId: number, days = 7): Promise<ActivityDay[]> {
  const { rows } = await db.raw(
    `
    WITH d AS (
      SELECT generate_series(${ADDIS_TODAY} - (? - 1), ${ADDIS_TODAY}, interval '1 day')::date AS day
    )
    SELECT
      to_char(d.day, 'YYYY-MM-DD') AS day,
      COALESCE(a.visits, 0)::int     AS visits,
      COALESCE(a.app_visits, 0)::int AS app_visits,
      COALESCE(a.web_visits, 0)::int AS web_visits,
      COALESCE(a.active_staff, 0)::int AS active_staff,
      COALESCE(m.added, 0)::int      AS members_added
    FROM d
    LEFT JOIN (
      SELECT day,
             sum(visits) AS visits,
             sum(visits) FILTER (WHERE source = 'app') AS app_visits,
             sum(visits) FILTER (WHERE source = 'web') AS web_visits,
             count(DISTINCT user_id) AS active_staff
        FROM staff_activity_days
       WHERE gym_id = ?
       GROUP BY day
    ) a ON a.day = d.day
    LEFT JOIN (
      SELECT (created_at AT TIME ZONE 'Africa/Addis_Ababa')::date AS day, count(*) AS added
        FROM members
       WHERE gym_id = ?
         AND created_at >= now() - (? * interval '1 day') - interval '1 day'
       GROUP BY 1
    ) m ON m.day = d.day
    ORDER BY d.day
  `,
    [days, gymId, gymId, days],
  );
  return rows;
}

export interface StaffToday {
  user_id: number;
  name: string;
  role: 'owner' | 'staff';
  visits: number;
  app_visits: number;
  web_visits: number;
  /** Most recent activity ever, not just today — null if they never signed in. */
  last_seen_at: string | null;
}

/**
 * Every live staff account of a gym with today's counts, including the ones
 * with none: "the receptionist has not opened the app today" is an answer,
 * and leaving them out would hide it.
 */
export async function staffToday(gymId: number): Promise<StaffToday[]> {
  const { rows } = await db.raw(
    `
    SELECT u.id AS user_id, u.name, u.role,
           COALESCE(t.visits, 0)::int     AS visits,
           COALESCE(t.app_visits, 0)::int AS app_visits,
           COALESCE(t.web_visits, 0)::int AS web_visits,
           ever.last_seen_at
      FROM users u
      LEFT JOIN (
        SELECT user_id,
               sum(visits) AS visits,
               sum(visits) FILTER (WHERE source = 'app') AS app_visits,
               sum(visits) FILTER (WHERE source = 'web') AS web_visits
          FROM staff_activity_days
         WHERE gym_id = ? AND day = ${ADDIS_TODAY}
         GROUP BY user_id
      ) t ON t.user_id = u.id
      LEFT JOIN LATERAL (
        SELECT max(last_seen_at) AS last_seen_at
          FROM staff_activity_days s
         WHERE s.user_id = u.id
      ) ever ON TRUE
     WHERE u.gym_id = ? AND u.deleted_at IS NULL
     ORDER BY visits DESC, u.role = 'owner' DESC, u.id
  `,
    [gymId, gymId],
  );
  return rows;
}
