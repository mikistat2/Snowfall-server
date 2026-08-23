"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.up = up;
exports.down = down;
/**
 * Platform-level feature entitlements.
 *
 * Distinct from `settings.camera_enabled`, which is the gym owner's own
 * preference and lives in the owner-writable settings JSONB. These two columns
 * are the platform's decision and are writable only through the owner-only
 * admin route, so a gym cannot grant itself a feature the platform revoked.
 *
 * The two are combined rather than replacing one another: the effective camera
 * state is `camera_allowed AND settings.camera_enabled` (see
 * gymModel.getSettings). Revoking therefore does not overwrite the owner's own
 * toggle — restore the entitlement and their prior choice comes back exactly
 * as it was, along with their enrolled face data, which is deliberately left
 * in place. Purging that data is a separate, explicit decision.
 *
 * Default true so every existing gym keeps working untouched.
 */
async function up(knex) {
    await knex.raw(`
    ALTER TABLE gyms
      ADD COLUMN camera_allowed   BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN telegram_allowed BOOLEAN NOT NULL DEFAULT true;
  `);
}
async function down(knex) {
    await knex.raw(`
    ALTER TABLE gyms
      DROP COLUMN IF EXISTS camera_allowed,
      DROP COLUMN IF EXISTS telegram_allowed;
  `);
}
//# sourceMappingURL=20260822000008_gym_feature_entitlements.js.map