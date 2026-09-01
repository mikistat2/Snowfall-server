import type { Knex } from 'knex';

/**
 * The five packages the public pricing page sells, as real billing_plans rows,
 * plus the columns that say what each package actually includes.
 *
 * Until now `billing_plans` carried only a name and two prices, so a row called
 * "Regular + Telegram" was a label and nothing more — the entitlements that
 * decide whether a gym may use Telegram or the camera live on `gyms`, and are
 * set by hand from the platform panel. These columns give the plan somewhere to
 * state its own contents, so the panel can show what each package grants and a
 * later change can apply it automatically.
 *
 * NOTE: nothing reads `camera`, `telegram` or `member_limit` yet. Adding them
 * is deliberately inert — wiring them into activation would change what paying
 * does to a live gym's entitlements, and existing gyms default to BOTH features
 * allowed, so a naive "set entitlements from the plan" would REVOKE camera from
 * every gym on Regular. That decision is separate from storing the data.
 *
 * The old seeded tiers are updated in place rather than deleted:
 * `billing_payments.billing_plan_id` is ON DELETE SET NULL, so dropping a row
 * would quietly detach historic payments from what was actually sold. Regular
 * and Max keep their ids and are repriced; Pro has no equivalent in the new
 * ladder and is deactivated, which hides it from gyms while its history stays
 * intact.
 */

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE billing_plans
      -- What the package includes. Both default FALSE: a plan grants nothing
      -- until someone says otherwise.
      ADD COLUMN camera       BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN telegram     BOOLEAN NOT NULL DEFAULT false,
      -- NULL = unlimited. Only the Free tier is capped today.
      ADD COLUMN member_limit INTEGER,
      -- One-time installation charge, separate from the recurring price. The
      -- billing cycle is still only MONTHLY or YEARLY; this records what the
      -- package costs to set up, it does not yet bill it.
      ADD COLUMN setup_fee    NUMERIC(12,2) NOT NULL DEFAULT 0,
      ADD CONSTRAINT billing_plans_member_limit_positive
        CHECK (member_limit IS NULL OR member_limit > 0);

    -- Repriced in place so any payment already pointing here stays attached.
    UPDATE billing_plans SET
      description   = 'The complete front desk: members, payments and check-ins in one place.',
      monthly_price = 2500,
      yearly_price  = 25000,
      camera        = false,
      telegram      = false,
      member_limit  = NULL,
      setup_fee     = 0,
      sort_order    = 2,
      is_active     = true,
      updated_at    = now()
    WHERE name = 'Regular';

    UPDATE billing_plans SET
      description   = 'Face recognition and Telegram together, with setup and support handled for you.',
      monthly_price = 4700,
      yearly_price  = 47000,
      camera        = true,
      telegram      = true,
      member_limit  = NULL,
      setup_fee     = 5000,
      sort_order    = 5,
      is_active     = true,
      updated_at    = now()
    WHERE name = 'Max';

    -- No equivalent in the new ladder. Switched off, not removed, and sunk to
    -- the bottom so a retired plan never sits between two live ones in the
    -- panel (which lists inactive plans too).
    UPDATE billing_plans SET
      is_active   = false,
      description = 'Retired — replaced by the Regular + Telegram and Regular + Camera packages.',
      sort_order  = 99,
      updated_at  = now()
    WHERE name = 'Pro';

    INSERT INTO billing_plans
      (name, description, monthly_price, yearly_price, camera, telegram, member_limit, setup_fee, sort_order, is_active)
    VALUES
      -- Inactive on purpose: Free is what a gym is on before it pays, not
      -- something it can buy. resolveCycle refuses a zero price anyway, so an
      -- active row here would only ever be a checkout option that rejects every
      -- payment. Kept as a row so the panel shows the whole ladder and the
      -- member cap has somewhere to live.
      ('Free', 'No subscription — the tier a gym is on before it pays.',
       0, 0, false, false, 20, 0, 1, false),
      ('Regular + Telegram', 'A Telegram bot that answers your members so your front desk does not have to.',
       3200, 32000, false, true, NULL, 0, 3, true),
      ('Regular + Camera', 'Members walk in and the door logs them. No cards, no queue at the desk.',
       4000, 40000, true, false, NULL, 5000, 4, true);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DELETE FROM billing_plans WHERE name IN ('Free', 'Regular + Telegram', 'Regular + Camera');

    UPDATE billing_plans SET
      description   = 'Up to 300 members — camera check-in, Telegram reminders, audit log.',
      monthly_price = 1200,
      yearly_price  = 10000,
      sort_order    = 1,
      updated_at    = now()
    WHERE name = 'Regular';

    UPDATE billing_plans SET
      description   = 'Up to 600 members — advanced analytics, branches, SMS reminders.',
      is_active     = true,
      sort_order    = 2,
      updated_at    = now()
    WHERE name = 'Pro';

    UPDATE billing_plans SET
      description   = 'Unlimited members — class scheduling, trainers, AI, on-site setup.',
      monthly_price = 2400,
      yearly_price  = 20000,
      sort_order    = 3,
      updated_at    = now()
    WHERE name = 'Max';

    ALTER TABLE billing_plans
      DROP CONSTRAINT IF EXISTS billing_plans_member_limit_positive,
      DROP COLUMN IF EXISTS camera,
      DROP COLUMN IF EXISTS telegram,
      DROP COLUMN IF EXISTS member_limit,
      DROP COLUMN IF EXISTS setup_fee;
  `);
}
