"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.up = up;
exports.down = down;
/**
 * Receipt-verified platform subscriptions.
 *
 * Gyms pay US (the platform) monthly or yearly by bank/wallet transfer, and
 * prove it by pasting a transaction ID or uploading a receipt screenshot. The
 * server pulls the real receipt from the provider's verification API, runs a
 * fixed set of rules against it, and extends `gyms.subscription_ends_at` only
 * when every rule passes.
 *
 * Tables:
 *  - billing_plans     the tiers we sell (mirrors the public /pricing page)
 *  - billing_settings  single row: master switch, our CBE/Telebirr accounts
 *  - billing_payments  one row per ATTEMPT, pass or fail — the rejected rows
 *                      are what we need when a gym owner disputes
 *
 * `billing_payments.verified_reference` is UNIQUE and is written **only** on
 * success. Postgres allows repeated NULLs under a unique index, so one receipt
 * can activate exactly one subscription (enforced by the database, not by
 * application logic, so it survives concurrent requests), while a receipt
 * rejected for a fixable reason can still be resubmitted once fixed.
 *
 * Nothing changes for existing gyms: `payments_required` starts FALSE, so the
 * paywall is inert until the platform owner turns it on.
 */
async function up(knex) {
    await knex.raw(`
    CREATE TABLE billing_plans (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      description   TEXT,
      monthly_price NUMERIC(12,2) NOT NULL DEFAULT 0,
      yearly_price  NUMERIC(12,2) NOT NULL DEFAULT 0,
      currency      TEXT NOT NULL DEFAULT 'ETB',
      is_active     BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order    SMALLINT NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Mirrors the tiers already advertised on the public /pricing page so the
    -- two cannot drift apart on day one. Editable from the platform panel.
    INSERT INTO billing_plans (name, description, monthly_price, yearly_price, sort_order) VALUES
      ('Regular', 'Up to 300 members — camera check-in, Telegram reminders, audit log.', 1200, 10000, 1),
      ('Pro',     'Up to 600 members — advanced analytics, branches, SMS reminders.',     1900, 15000, 2),
      ('Max',     'Unlimited members — class scheduling, trainers, AI, on-site setup.',   2400, 20000, 3);

    -- Single row, keyed the same way as platform_settings.
    CREATE TABLE billing_settings (
      id                    BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
      payments_required     BOOLEAN NOT NULL DEFAULT FALSE,
      cbe_enabled           BOOLEAN NOT NULL DEFAULT TRUE,
      cbe_account_number    TEXT,
      cbe_account_name      TEXT,
      telebirr_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
      telebirr_phone        TEXT,
      telebirr_account_name TEXT,
      currency              TEXT NOT NULL DEFAULT 'ETB',
      receipt_max_age_days  SMALLINT NOT NULL DEFAULT 7  CHECK (receipt_max_age_days BETWEEN 1 AND 365),
      grace_days            SMALLINT NOT NULL DEFAULT 0  CHECK (grace_days BETWEEN 0 AND 90),
      instructions          TEXT,
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    INSERT INTO billing_settings DEFAULT VALUES;

    ALTER TABLE gyms
      -- Minted once and stable for the life of the account: the same code is
      -- typed as the transfer reason for the first payment and every renewal,
      -- so a gym that pays late or renews next year still matches.
      ADD COLUMN payment_reason_code VARCHAR(6) UNIQUE,
      ADD COLUMN billing_plan_id     INTEGER REFERENCES billing_plans(id) ON DELETE SET NULL,
      ADD COLUMN billing_cycle       VARCHAR(8) CHECK (billing_cycle IN ('MONTHLY', 'YEARLY')),
      -- Never charged: set at registration for gyms that signed up while the
      -- master switch was off, or granted by hand from the platform panel.
      -- Turning the paywall back on must not retroactively lock these out.
      ADD COLUMN comped              BOOLEAN NOT NULL DEFAULT FALSE;

    CREATE TABLE billing_payments (
      id                 SERIAL PRIMARY KEY,
      gym_id             INTEGER NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
      billing_plan_id    INTEGER REFERENCES billing_plans(id) ON DELETE SET NULL,
      provider           VARCHAR(16) NOT NULL CHECK (provider IN ('CBE', 'TELEBIRR', 'CASH')),
      source             VARCHAR(16) NOT NULL CHECK (source   IN ('MANUAL', 'IMAGE', 'ADMIN')),
      status             VARCHAR(16) NOT NULL CHECK (status   IN ('PENDING', 'VERIFIED', 'REJECTED')),
      reference          TEXT,
      reason_code        VARCHAR(6),
      -- load-bearing: the anti-replay guarantee. Written only on success.
      verified_reference TEXT UNIQUE,
      selected_cycle     VARCHAR(8),
      granted_cycle      VARCHAR(8),
      amount             NUMERIC(12,2),
      currency           TEXT,
      expected_amount    NUMERIC(12,2),
      payer_name         TEXT,
      payer_account      TEXT,
      receiver_name      TEXT,
      receiver_account   TEXT,
      transaction_at     TIMESTAMPTZ,
      period_start       TIMESTAMPTZ,
      period_end         TIMESTAMPTZ,
      failure_reason     TEXT,
      warnings           JSONB,
      checks             JSONB,
      -- contains the payer's full account number — never leaves the server
      raw_response       JSONB,
      recorded_by        TEXT,
      note               TEXT,
      verified_at        TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX billing_payments_gym_status_idx ON billing_payments (gym_id, status);
    CREATE INDEX billing_payments_reference_idx  ON billing_payments (reference);
    CREATE INDEX billing_payments_created_idx    ON billing_payments (created_at DESC);
  `);
}
async function down(knex) {
    await knex.raw(`
    DROP TABLE IF EXISTS billing_payments;
    ALTER TABLE gyms
      DROP COLUMN IF EXISTS payment_reason_code,
      DROP COLUMN IF EXISTS billing_plan_id,
      DROP COLUMN IF EXISTS billing_cycle,
      DROP COLUMN IF EXISTS comped;
    DROP TABLE IF EXISTS billing_settings;
    DROP TABLE IF EXISTS billing_plans;
  `);
}
//# sourceMappingURL=20260811000006_billing.js.map