"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.up = up;
exports.down = down;
/**
 * Platform administration: gyms gain a status so the platform owner can
 * freeze (suspend) a tenant without deleting its data.
 */
async function up(knex) {
    await knex.raw(`
    ALTER TABLE gyms
      ADD COLUMN status      TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'frozen')),
      ADD COLUMN frozen_at   TIMESTAMPTZ,
      ADD COLUMN admin_note  TEXT;
  `);
}
async function down(knex) {
    await knex.raw(`
    ALTER TABLE gyms
      DROP COLUMN IF EXISTS status,
      DROP COLUMN IF EXISTS frozen_at,
      DROP COLUMN IF EXISTS admin_note;
  `);
}
//# sourceMappingURL=20260717000003_gym_status.js.map