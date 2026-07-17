import type { Knex } from 'knex';

/**
 * Platform administration: gyms gain a status so the platform owner can
 * freeze (suspend) a tenant without deleting its data.
 */

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE gyms
      ADD COLUMN status      TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'frozen')),
      ADD COLUMN frozen_at   TIMESTAMPTZ,
      ADD COLUMN admin_note  TEXT;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE gyms
      DROP COLUMN IF EXISTS status,
      DROP COLUMN IF EXISTS frozen_at,
      DROP COLUMN IF EXISTS admin_note;
  `);
}
