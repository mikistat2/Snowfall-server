import type { Knex } from 'knex';

/**
 * Splits the freeze reason out of `admin_note`.
 *
 * `admin_note` is the platform admin's *private* scratchpad ("Private note
 * (only you see this)" in the panel). The freeze dialog was writing the
 * owner-facing reason into that same column, so the two clobbered each other:
 * freezing a gym erased the private note, and editing the private note
 * silently rewrote the reason the owner had been given.
 *
 * That collision is also why the reason could never be shown in the app — a
 * column that may hold private remarks cannot be sent to the tenant. With its
 * own column it can be, and it is: the 403 GYM_FROZEN body now carries it, so
 * the owner reads the admin's words on the login screen and in the app instead
 * of only in a best-effort Telegram/email that may never have arrived.
 *
 * Backfilled for gyms that are frozen *right now*, where `admin_note` is the
 * reason the old code stored. Active gyms are left alone — there the column is
 * a private note and must stay private.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE gyms ADD COLUMN freeze_note TEXT;

    UPDATE gyms
       SET freeze_note = admin_note
     WHERE status = 'frozen'
       AND admin_note IS NOT NULL;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE gyms DROP COLUMN IF EXISTS freeze_note;`);
}
