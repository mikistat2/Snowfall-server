import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE platform_settings
      ADD COLUMN approval_required BOOLEAN NOT NULL DEFAULT TRUE;

    UPDATE platform_settings
      SET approval_required = NOT trial_mode;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE platform_settings
      DROP COLUMN IF EXISTS approval_required;
  `);
}