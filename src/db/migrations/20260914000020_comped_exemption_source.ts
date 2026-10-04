import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE gyms
      ADD COLUMN comped_by_admin BOOLEAN NOT NULL DEFAULT FALSE;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE gyms
      DROP COLUMN IF EXISTS comped_by_admin;
  `);
}
