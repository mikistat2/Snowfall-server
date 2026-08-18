import type { Knex } from 'knex';

/**
 * Archiving members.
 *
 * `payments` is an immutable audit trail (a trigger rejects UPDATE and DELETE)
 * and payments.member_id has no cascade, so a member who has ever paid cannot
 * be deleted without destroying financial history. Archiving is the answer for
 * them: the row stays, the money stays, but the member disappears from the
 * lists, the door monitor and the reminder jobs — and can be brought back.
 *
 * Members with no payments at all (a duplicate typed twice while back-filling a
 * paper register) are deleted outright instead; nothing here applies to them.
 *
 * The partial index matches the shape of nearly every read — "the members of
 * this gym who are not archived" — so the added filter costs nothing.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE members ADD COLUMN archived_at TIMESTAMPTZ;
    CREATE INDEX members_gym_id_active_idx ON members (gym_id) WHERE archived_at IS NULL;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP INDEX IF EXISTS members_gym_id_active_idx;
    ALTER TABLE members DROP COLUMN IF EXISTS archived_at;
  `);
}
