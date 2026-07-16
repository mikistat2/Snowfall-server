"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.up = up;
exports.down = down;
/**
 * Phase 2: staff/owner Telegram linking (admin alerts + daily summaries go to
 * the owner's chat). Mirrors the member linking columns.
 */
async function up(knex) {
    await knex.raw(`
    ALTER TABLE users
      ADD COLUMN telegram_chat_id BIGINT,
      ADD COLUMN telegram_link_token TEXT;

    CREATE UNIQUE INDEX users_telegram_link_token_idx
      ON users (telegram_link_token) WHERE telegram_link_token IS NOT NULL;
  `);
}
async function down(knex) {
    await knex.raw(`
    ALTER TABLE users
      DROP COLUMN IF EXISTS telegram_chat_id,
      DROP COLUMN IF EXISTS telegram_link_token;
  `);
}
//# sourceMappingURL=20260714000002_user_telegram.js.map