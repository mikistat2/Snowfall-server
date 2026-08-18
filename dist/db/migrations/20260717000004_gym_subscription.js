"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.up = up;
exports.down = down;
/**
 * Yearly platform subscriptions + registration approval:
 *  - gyms.status gains 'pending' (new registrations wait for platform-admin
 *    approval before they can log in).
 *  - approved_at / subscription_ends_at / is_trial track the paid year or
 *    free trial granted by the platform admin.
 *  - platform_settings (single row) holds the global "free trial mode"
 *    switch: when on, new gyms skip approval and start a trial.
 * Existing gyms are grandfathered: approved at creation, paid until
 * created_at + 1 year.
 */
async function up(knex) {
    await knex.raw(`
    ALTER TABLE gyms DROP CONSTRAINT gyms_status_check;
    ALTER TABLE gyms
      ADD CONSTRAINT gyms_status_check CHECK (status IN ('pending', 'active', 'frozen')),
      ADD COLUMN approved_at          TIMESTAMPTZ,
      ADD COLUMN subscription_ends_at TIMESTAMPTZ,
      ADD COLUMN is_trial             BOOLEAN NOT NULL DEFAULT FALSE;

    UPDATE gyms
      SET approved_at = created_at,
          subscription_ends_at = created_at + interval '1 year';

    CREATE TABLE platform_settings (
      id          BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
      trial_mode  BOOLEAN NOT NULL DEFAULT FALSE,
      trial_days  INTEGER NOT NULL DEFAULT 30 CHECK (trial_days BETWEEN 1 AND 365),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    INSERT INTO platform_settings DEFAULT VALUES;
  `);
}
async function down(knex) {
    await knex.raw(`
    DROP TABLE IF EXISTS platform_settings;
    ALTER TABLE gyms
      DROP COLUMN IF EXISTS approved_at,
      DROP COLUMN IF EXISTS subscription_ends_at,
      DROP COLUMN IF EXISTS is_trial;
    ALTER TABLE gyms DROP CONSTRAINT gyms_status_check;
    ALTER TABLE gyms
      ADD CONSTRAINT gyms_status_check CHECK (status IN ('active', 'frozen'));
  `);
}
//# sourceMappingURL=20260717000004_gym_subscription.js.map