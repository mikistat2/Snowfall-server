import type { Knex } from 'knex';

/**
 * Correcting a payment, without giving up the immutable audit trail.
 *
 * The problem this solves is ordinary and daily: a gym meant to type 2300 and
 * typed 23002300. Until now the only remedy was hand-written SQL against
 * production, because `payments_immutable` refuses every UPDATE and DELETE —
 * which is the right instinct (money that changed hands is a fact, not a
 * field) but leaves no way to record that the fact was written down wrong.
 *
 * An edit is therefore modelled as two append-only acts rather than a mutation:
 *
 *   1. the wrong row is VOIDED — struck through, never erased, stamped with
 *      who did it and why;
 *   2. a replacement row is inserted carrying `corrects_id` back to it.
 *
 * The replacement keeps the ORIGINAL `created_at`. The money moved on the day
 * it moved, so a correction typed in September for a payment taken in June
 * belongs in June's revenue — otherwise fixing a typo silently rewrites two
 * months of takings. When the correction was *entered* is in `audit_logs`,
 * which is the question that column can actually answer.
 *
 * The trigger is relaxed, not removed. It still refuses every DELETE and every
 * UPDATE except the one-way void, and it refuses even that if any other column
 * moves — so "voided" cannot become a back door to editing an amount in place.
 * Enforcing this in the trigger rather than in the controller is the point: an
 * audit trail guarded only by application code is a convention, not a trail.
 *
 * No new index. Every revenue query gains `voided_at IS NULL`, but voided rows
 * are a rounding error in this table and `payments_gym_id_created_at_idx`
 * already orders the scan; a second index on the busiest financial table would
 * cost every write to save a filter on almost nothing.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE payments
      ADD COLUMN voided_at   TIMESTAMPTZ,
      ADD COLUMN voided_by   BIGINT REFERENCES users(id),
      ADD COLUMN void_reason TEXT,
      ADD COLUMN corrects_id BIGINT REFERENCES payments(id);

    COMMENT ON COLUMN payments.corrects_id IS
      'The voided payment this row replaces. Set only on a correction.';

    CREATE OR REPLACE FUNCTION reject_payment_mutation() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'payments are an immutable audit trail (DELETE blocked)';
      END IF;

      -- A void is one-way. Re-voiding would let the reason and the responsible
      -- user be rewritten after the fact, which is the whole thing we are
      -- protecting.
      IF OLD.voided_at IS NOT NULL THEN
        RAISE EXCEPTION 'payment % is already voided and cannot be changed again', OLD.id;
      END IF;

      IF NEW.voided_at IS NULL THEN
        RAISE EXCEPTION 'payments are an immutable audit trail (UPDATE blocked)';
      END IF;
      IF NEW.voided_by IS NULL THEN
        RAISE EXCEPTION 'a void must record which user performed it';
      END IF;
      IF NEW.void_reason IS NULL OR btrim(NEW.void_reason) = '' THEN
        RAISE EXCEPTION 'a void must record a reason';
      END IF;

      -- Everything that describes the payment itself must be untouched: the
      -- only legal transition is live -> voided.
      IF ROW(NEW.id, NEW.gym_id, NEW.member_id, NEW.subscription_id, NEW.amount,
             NEW.method, NEW.marked_by, NEW.note, NEW.created_at, NEW.corrects_id)
         IS DISTINCT FROM
         ROW(OLD.id, OLD.gym_id, OLD.member_id, OLD.subscription_id, OLD.amount,
             OLD.method, OLD.marked_by, OLD.note, OLD.created_at, OLD.corrects_id)
      THEN
        RAISE EXCEPTION 'a void may only set voided_at, voided_by and void_reason';
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
}

/**
 * Voided rows become live again on the way down — there is nowhere else to put
 * them once the columns are gone, and silently deleting money rows to make a
 * rollback tidy would be the worst possible trade.
 */
export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION reject_payment_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'payments are an immutable audit trail (% blocked)', TG_OP;
    END;
    $$ LANGUAGE plpgsql;

    ALTER TABLE payments
      DROP COLUMN IF EXISTS voided_at,
      DROP COLUMN IF EXISTS voided_by,
      DROP COLUMN IF EXISTS void_reason,
      DROP COLUMN IF EXISTS corrects_id;
  `);
}
