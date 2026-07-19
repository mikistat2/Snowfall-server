import type { Knex } from 'knex';

/**
 * Sub-admins for the platform control panel. The product owner (env
 * credentials) creates these accounts and can remove them at any time.
 * They can NEVER delete gyms, change platform settings or manage other
 * admins — those stay owner-only in the routes. What they CAN do is
 * per-account: the owner toggles approve / freeze / renew / export.
 */

export async function up(knex: Knex): Promise<void> {
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

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS platform_admins;');
}
