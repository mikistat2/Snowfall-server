import type { Knex } from 'knex';

/**
 * Phase 2: staff/owner Telegram linking (admin alerts + daily summaries go to
 * the owner's chat). Mirrors the member linking columns.
 */

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE users
      ADD COLUMN telegram_chat_id BIGINT,
      ADD COLUMN telegram_link_token TEXT;

    CREATE UNIQUE INDEX users_telegram_link_token_idx
      ON users (telegram_link_token) WHERE telegram_link_token IS NOT NULL;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE users
      DROP COLUMN IF EXISTS telegram_chat_id,
      DROP COLUMN IF EXISTS telegram_link_token;
  `);
}
