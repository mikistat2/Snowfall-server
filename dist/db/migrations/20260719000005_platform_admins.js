"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.up = up;
exports.down = down;
/**
 * Sub-admins for the platform control panel. The product owner (env
 * credentials) creates these accounts and can remove them at any time.
 * They can NEVER delete gyms, change platform settings or manage other
 * admins — those stay owner-only in the routes. What they CAN do is
 * per-account: the owner toggles approve / freeze / renew / export.
 */
async function up(knex) {
    await knex.raw(`
    CREATE TABLE platform_admins (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      can_approve   BOOLEAN NOT NULL DEFAULT TRUE,
      can_freeze    BOOLEAN NOT NULL DEFAULT TRUE,
      can_renew     BOOLEAN NOT NULL DEFAULT TRUE,
      can_export    BOOLEAN NOT NULL DEFAULT FALSE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}
async function down(knex) {
    await knex.raw('DROP TABLE IF EXISTS platform_admins;');
}
//# sourceMappingURL=20260719000005_platform_admins.js.map