import type { Knex } from 'knex';

/**
 * Initial schema — all Phase 1–3 tables.
 *
 * Conventions:
 *  - BIGSERIAL primary keys.
 *  - Every tenant-scoped table carries gym_id (subscriptions included, even
 *    though it is reachable via members, so expiry queries stay single-table).
 *  - face_descriptors is a pure child of members (tenant scope via join).
 *  - Enums enforced with CHECK constraints (cheap to extend later).
 *  - payments are immutable: a trigger rejects UPDATE/DELETE (audit trail).
 */

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    -- ============================================================
    -- Helper: keep updated_at current on mutable tables
    -- ============================================================
    CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    -- ============================================================
    -- gyms (tenants)
    -- ============================================================
    CREATE TABLE gyms (
      id                  BIGSERIAL PRIMARY KEY,
      name                TEXT NOT NULL,
      address             TEXT,
      phone               TEXT,
      telegram_bot_token  TEXT,
      settings            JSONB NOT NULL DEFAULT '{
                            "grace_period_days": 3,
                            "auto_checkout_hours": 3,
                            "expiry_reminder_days": 7,
                            "absence_nudge_days": 5,
                            "match_threshold": 0.5,
                            "closing_time": "22:00"
                          }',
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TRIGGER gyms_updated_at BEFORE UPDATE ON gyms
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- ============================================================
    -- users (staff accounts)
    -- ============================================================
    CREATE TABLE users (
      id             BIGSERIAL PRIMARY KEY,
      gym_id         BIGINT NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
      name           TEXT NOT NULL,
      phone          TEXT,
      email          TEXT NOT NULL UNIQUE,
      password_hash  TEXT NOT NULL,
      role           TEXT NOT NULL CHECK (role IN ('owner', 'staff')),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX users_gym_id_idx ON users (gym_id);
    CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- ============================================================
    -- refresh_tokens (revocable JWT refresh tokens; hashed at rest)
    -- ============================================================
    CREATE TABLE refresh_tokens (
      id          BIGSERIAL PRIMARY KEY,
      user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash  TEXT NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      revoked_at  TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX refresh_tokens_token_hash_idx ON refresh_tokens (token_hash);
    CREATE INDEX refresh_tokens_user_id_idx ON refresh_tokens (user_id);

    -- ============================================================
    -- plans (per-gym membership plans)
    -- ============================================================
    CREATE TABLE plans (
      id                BIGSERIAL PRIMARY KEY,
      gym_id            BIGINT NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
      name              TEXT NOT NULL,
      duration_days     INTEGER NOT NULL CHECK (duration_days > 0),
      price             NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
      -- 1 = one session per day, NULL = unlimited
      sessions_per_day  INTEGER CHECK (sessions_per_day IS NULL OR sessions_per_day = 1),
      includes          JSONB NOT NULL DEFAULT '{}',
      -- "HH:MM-HH:MM" local time window, NULL = any time
      allowed_hours     TEXT CHECK (allowed_hours IS NULL OR allowed_hours ~ '^\\d{2}:\\d{2}-\\d{2}:\\d{2}$'),
      active            BOOLEAN NOT NULL DEFAULT TRUE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX plans_gym_id_idx ON plans (gym_id);
    CREATE TRIGGER plans_updated_at BEFORE UPDATE ON plans
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- ============================================================
    -- members
    -- ============================================================
    CREATE TABLE members (
      id                   BIGSERIAL PRIMARY KEY,
      gym_id               BIGINT NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
      full_name            TEXT NOT NULL,
      phone                TEXT,
      sex                  TEXT CHECK (sex IN ('male', 'female')),
      telegram_chat_id     BIGINT,
      telegram_username    TEXT,
      -- one-time deep-link token for t.me/<bot>?start=<token> (Phase 2)
      telegram_link_token  TEXT,
      photo_url            TEXT,
      status               TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'expiring', 'grace', 'expired', 'frozen')),
      joined_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX members_gym_id_status_idx ON members (gym_id, status);
    CREATE INDEX members_gym_id_phone_idx ON members (gym_id, phone);
    CREATE UNIQUE INDEX members_telegram_link_token_idx
      ON members (telegram_link_token) WHERE telegram_link_token IS NOT NULL;
    CREATE TRIGGER members_updated_at BEFORE UPDATE ON members
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- ============================================================
    -- face_descriptors (3–5 captures per member, 128-d each)
    -- ============================================================
    CREATE TABLE face_descriptors (
      id          BIGSERIAL PRIMARY KEY,
      member_id   BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      descriptor  REAL[] NOT NULL CHECK (array_length(descriptor, 1) = 128),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX face_descriptors_member_id_idx ON face_descriptors (member_id);

    -- ============================================================
    -- subscriptions
    -- ============================================================
    CREATE TABLE subscriptions (
      id                     BIGSERIAL PRIMARY KEY,
      gym_id                 BIGINT NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
      member_id              BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      plan_id                BIGINT NOT NULL REFERENCES plans(id),
      starts_at              DATE NOT NULL,
      expires_at             DATE NOT NULL,
      frozen_at              TIMESTAMPTZ,
      frozen_days_remaining  INTEGER CHECK (frozen_days_remaining IS NULL OR frozen_days_remaining >= 0),
      status                 TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'frozen', 'expired')),
      created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (expires_at >= starts_at)
    );
    CREATE INDEX subscriptions_member_id_idx ON subscriptions (member_id, expires_at DESC);
    CREATE INDEX subscriptions_gym_id_expires_at_idx ON subscriptions (gym_id, expires_at);
    CREATE TRIGGER subscriptions_updated_at BEFORE UPDATE ON subscriptions
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- ============================================================
    -- payments (immutable audit trail)
    -- ============================================================
    CREATE TABLE payments (
      id               BIGSERIAL PRIMARY KEY,
      gym_id           BIGINT NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
      member_id        BIGINT NOT NULL REFERENCES members(id),
      subscription_id  BIGINT NOT NULL REFERENCES subscriptions(id),
      amount           NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
      method           TEXT NOT NULL CHECK (method IN ('cash', 'telebirr', 'bank', 'other')),
      marked_by        BIGINT NOT NULL REFERENCES users(id),
      note             TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX payments_gym_id_created_at_idx ON payments (gym_id, created_at DESC);
    CREATE INDEX payments_member_id_idx ON payments (member_id);

    CREATE FUNCTION reject_payment_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'payments are an immutable audit trail (% blocked)', TG_OP;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER payments_immutable
      BEFORE UPDATE OR DELETE ON payments
      FOR EACH ROW EXECUTE FUNCTION reject_payment_mutation();

    -- ============================================================
    -- guests (day passes / trials; descriptor nulled by cron after expiry)
    -- ============================================================
    CREATE TABLE guests (
      id                   BIGSERIAL PRIMARY KEY,
      gym_id               BIGINT NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
      name                 TEXT NOT NULL,
      descriptor           REAL[] CHECK (descriptor IS NULL OR array_length(descriptor, 1) = 128),
      valid_until          TIMESTAMPTZ NOT NULL,
      created_by           BIGINT NOT NULL REFERENCES users(id),
      converted_member_id  BIGINT REFERENCES members(id),
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX guests_gym_id_valid_until_idx ON guests (gym_id, valid_until);

    -- ============================================================
    -- check_ins
    -- ============================================================
    CREATE TABLE check_ins (
      id               BIGSERIAL PRIMARY KEY,
      gym_id           BIGINT NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
      member_id        BIGINT REFERENCES members(id) ON DELETE CASCADE,
      guest_id         BIGINT REFERENCES guests(id),
      checked_in_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      checked_out_at   TIMESTAMPTZ,
      checkout_method  TEXT CHECK (checkout_method IN ('camera', 'auto', 'manual')),
      decision         TEXT NOT NULL CHECK (decision IN (
                         'allowed',
                         'denied_expired',
                         'denied_frozen',
                         'denied_session_limit',
                         'denied_hours',
                         'override'
                       )),
      confidence       REAL,
      CHECK (member_id IS NOT NULL OR guest_id IS NOT NULL),
      CHECK (checked_out_at IS NULL OR checked_out_at >= checked_in_at)
    );
    CREATE INDEX check_ins_gym_id_time_idx ON check_ins (gym_id, checked_in_at DESC);
    CREATE INDEX check_ins_member_id_time_idx ON check_ins (member_id, checked_in_at DESC);
    -- fast occupancy: open sessions per gym
    CREATE INDEX check_ins_open_idx ON check_ins (gym_id) WHERE checked_out_at IS NULL;

    -- ============================================================
    -- notifications (every Telegram send attempt)
    -- ============================================================
    CREATE TABLE notifications (
      id         BIGSERIAL PRIMARY KEY,
      gym_id     BIGINT NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
      member_id  BIGINT REFERENCES members(id) ON DELETE CASCADE,
      type       TEXT NOT NULL CHECK (type IN (
                   'expiry_reminder',
                   'expired',
                   'absence_nudge',
                   'receipt',
                   'admin_alert',
                   'admin_summary'
                 )),
      channel    TEXT NOT NULL DEFAULT 'bot' CHECK (channel IN ('bot', 'mtproto')),
      status     TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped_no_chat_id')),
      payload    JSONB NOT NULL DEFAULT '{}',
      sent_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX notifications_gym_id_sent_at_idx ON notifications (gym_id, sent_at DESC);
    -- supports "never send the same nudge twice within 7 days"
    CREATE INDEX notifications_member_type_sent_idx ON notifications (member_id, type, sent_at DESC);

    -- ============================================================
    -- events (live monitor feed)
    -- ============================================================
    CREATE TABLE events (
      id          BIGSERIAL PRIMARY KEY,
      gym_id      BIGINT NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
      type        TEXT NOT NULL,
      severity    TEXT NOT NULL CHECK (severity IN ('green', 'yellow', 'orange', 'red', 'blue')),
      message     TEXT NOT NULL,
      member_id   BIGINT REFERENCES members(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX events_gym_id_created_at_idx ON events (gym_id, created_at DESC);

    -- ============================================================
    -- audit_logs (staff actions)
    -- ============================================================
    CREATE TABLE audit_logs (
      id          BIGSERIAL PRIMARY KEY,
      gym_id      BIGINT NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
      user_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
      action      TEXT NOT NULL,
      entity      TEXT NOT NULL,
      entity_id   BIGINT,
      meta        JSONB NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX audit_logs_gym_id_created_at_idx ON audit_logs (gym_id, created_at DESC);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS audit_logs;
    DROP TABLE IF EXISTS events;
    DROP TABLE IF EXISTS notifications;
    DROP TABLE IF EXISTS check_ins;
    DROP TABLE IF EXISTS guests;
    DROP TABLE IF EXISTS payments;
    DROP TABLE IF EXISTS subscriptions;
    DROP TABLE IF EXISTS face_descriptors;
    DROP TABLE IF EXISTS members;
    DROP TABLE IF EXISTS plans;
    DROP TABLE IF EXISTS refresh_tokens;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS gyms;
    DROP FUNCTION IF EXISTS reject_payment_mutation();
    DROP FUNCTION IF EXISTS set_updated_at();
  `);
}
