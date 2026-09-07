import type { Knex } from 'knex';

/**
 * Removable staff accounts.
 *
 * A staff account cannot be DELETEd. `payments.marked_by` and
 * `guests.created_by` both reference `users(id)` with no ON DELETE clause, so
 * Postgres refuses the delete for anyone who has ever taken money or signed in
 * a guest; and the escape hatches are worse than the problem — `payments`
 * carries an immutability trigger that blocks the UPDATE an ON DELETE SET NULL
 * would have to perform, and reassigning `marked_by` to somebody else would
 * forge the audit trail this system exists to keep. (The gym owner's own
 * "remove staff" button has been hard-deleting all along, which is why it
 * fails with a foreign-key error on precisely the staff who did the most work.)
 *
 * So removal is a tombstone: `deleted_at` set, every session revoked, the row
 * left in place so `marked_by` still resolves to a name. The account is gone
 * from every list, cannot sign in, and stops receiving Telegram and email —
 * see userModel, where every read filters on this column.
 *
 * The UNIQUE on `email` becomes a partial index so a removed address can be
 * used again. Without that, deleting an account would permanently burn its
 * email — the opposite of what "removed" should mean, and a support call the
 * first time somebody re-hires a receptionist.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE users
      ADD COLUMN deleted_at TIMESTAMPTZ,
      ADD COLUMN deleted_by TEXT;

    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
    CREATE UNIQUE INDEX users_email_live_idx ON users (email) WHERE deleted_at IS NULL;
  `);
}

/**
 * Restoring the plain UNIQUE will fail if a removed account shares an email
 * with a live one — which is exactly the state this migration made legal.
 * That failure is the honest outcome: the alternative is deleting somebody's
 * rows to make a rollback tidy.
 */
export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP INDEX IF EXISTS users_email_live_idx;
    ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email);
    ALTER TABLE users DROP COLUMN IF EXISTS deleted_at;
    ALTER TABLE users DROP COLUMN IF EXISTS deleted_by;
  `);
}
