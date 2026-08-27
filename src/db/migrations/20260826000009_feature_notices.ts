import type { Knex } from 'knex';

/**
 * A durable record of every platform decision a gym has to be TOLD about.
 *
 * The entitlement columns added in 20260822000008 answer "can this gym use the
 * camera right now"; they cannot answer "did anyone ever tell the owner it was
 * switched off, and did they see it". A boolean has no history, so a gym whose
 * camera stopped working found out by the monitor going quiet.
 *
 * One row per *change*, written by the platform panel at the moment it acts:
 *  - `allowed` is the state the feature moved TO, so the row is readable on
 *    its own without replaying the whole table;
 *  - `note` is the admin's own words, which is the part owners actually need
 *    ("your camera licence lapsed" vs. silence);
 *  - `acknowledged_at` is what stops the in-app alert re-appearing forever.
 *    It is per-gym, not per-user: one owner dismissing it settles it for the
 *    account, the same way the freeze alert does.
 *
 * Rows are never deleted. Re-enabling writes a second row rather than clearing
 * the first, so a disputed lockout can be reconstructed months later.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE gym_feature_notices (
      id              SERIAL PRIMARY KEY,
      gym_id          INTEGER NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
      feature         VARCHAR(16) NOT NULL CHECK (feature IN ('camera', 'telegram')),
      allowed         BOOLEAN NOT NULL,
      note            TEXT,
      changed_by      TEXT,
      acknowledged_at TIMESTAMPTZ,
      acknowledged_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- The app asks "anything unseen for this gym?" on every load; that read is
    -- the one that has to stay cheap.
    CREATE INDEX gym_feature_notices_pending_idx
      ON gym_feature_notices (gym_id, created_at DESC)
      WHERE acknowledged_at IS NULL;

    CREATE INDEX gym_feature_notices_gym_idx ON gym_feature_notices (gym_id, created_at DESC);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS gym_feature_notices;`);
}
