import type { Knex } from 'knex';

/**
 * Which billing cycles the platform actually sells.
 *
 * Until now monthly and yearly were both always on offer, hard-coded into
 * every screen that shows a price. Selling only yearly (or only monthly) meant
 * editing the client.
 *
 * Both default TRUE, so applying this migration changes nothing for anybody:
 * the toggles exist but the offer is exactly what it was. That matters more
 * than usual here — there are gyms running an Android build that predates this
 * work, and they must keep behaving identically until they are handed a new
 * APK. See billingService.enabledCycles for the other half of that promise:
 * the flags steer what is OFFERED and are never used to refuse a payment, so
 * an old install that still shows monthly can still complete one.
 *
 * The CHECK is the point of the constraint being in the database rather than
 * only in the settings form: with both off there is nothing to sell, every
 * price screen renders empty, and the platform owner has locked their own
 * paywall shut with no in-app way back.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE billing_settings
      ADD COLUMN monthly_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN yearly_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
      ADD CONSTRAINT billing_settings_one_cycle CHECK (monthly_enabled OR yearly_enabled);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE billing_settings
      DROP CONSTRAINT IF EXISTS billing_settings_one_cycle,
      DROP COLUMN IF EXISTS monthly_enabled,
      DROP COLUMN IF EXISTS yearly_enabled;
  `);
}
