import type { Knex } from 'knex';

/**
 * How often each gym's staff actually open the app or the website.
 *
 * The platform owner could see a gym's members, payments and check-ins, but
 * not whether anybody at the gym was using the system at all — a gym that has
 * quietly stopped opening the app looks identical to a busy one until its
 * subscription lapses. This is that missing signal.
 *
 * Collected entirely on the server, from the authenticated requests every
 * client already makes the moment it opens. That is deliberate: the Android
 * app is sideloaded and cannot be updated on demand, so anything that needed a
 * client change would only ever measure the gyms that happened to reinstall.
 *
 * One row per person, per day, per source — not one row per request. A
 * "visit" starts when someone comes back after 30 minutes away; see
 * staffActivityService for how that is decided without a write per request.
 *
 * `day` is the calendar day in Addis Ababa, not UTC. Render runs in UTC, so a
 * UTC day would put a gym's first three hours of every morning on the previous
 * day. It is a DATE, so the existing pg type parser (db/knex.ts) hands it to
 * the client as a plain "YYYY-MM-DD" string that cannot shift a day.
 *
 * Deleted with the gym (both foreign keys cascade). Staff accounts are
 * tombstoned rather than deleted, so a removed employee's history stays.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE staff_activity_days (
      user_id       BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      gym_id        BIGINT      NOT NULL REFERENCES gyms(id)  ON DELETE CASCADE,
      day           DATE        NOT NULL,
      source        TEXT        NOT NULL CHECK (source IN ('app', 'web')),
      visits        INTEGER     NOT NULL DEFAULT 1 CHECK (visits > 0),
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, day, source)
    );

    -- Every read is "this gym, these days": the platform list asks for today
    -- across all gyms, the detail view for one gym's last week.
    CREATE INDEX staff_activity_days_gym_day_idx ON staff_activity_days (gym_id, day);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS staff_activity_days;`);
}
