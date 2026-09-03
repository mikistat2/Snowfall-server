import type { Knex } from 'knex';
import { db } from '../db/knex';
import {
  DEFAULT_SETTINGS,
  type BillingCycle,
  type GymFeatures,
  type GymRow,
  type GymSettings,
} from '../types';

export async function findById(id: number, trx: Knex = db): Promise<GymRow | undefined> {
  return trx('gyms').where({ id }).first();
}

export async function create(
  data: {
    name: string;
    address?: string | null;
    phone?: string | null;
    status?: 'pending' | 'active';
    is_trial?: boolean;
    approved_at?: Date | null;
    subscription_ends_at?: Date | null;
    comped?: boolean;
    /** The package and cycle signed up for, before any payment has been made. */
    billing_plan_id?: number | null;
    billing_cycle?: BillingCycle | null;
    /**
     * Both columns DEFAULT true, which is right for the gyms that predate
     * them but wrong for a new signup — see authService's UNPAID_ENTITLEMENTS.
     * Passing them explicitly is what makes a new gym start on what it is
     * entitled to rather than on everything.
     */
    camera_allowed?: boolean;
    telegram_allowed?: boolean;
  },
  trx: Knex = db,
): Promise<GymRow> {
  const [row] = await trx('gyms')
    .insert({ ...data, settings: JSON.stringify(DEFAULT_SETTINGS) })
    .returning('*');
  return row;
}

export async function update(
  id: number,
  data: Partial<{ name: string; address: string | null; phone: string | null; telegram_bot_token: string | null }>,
): Promise<GymRow> {
  const [row] = await db('gyms').where({ id }).update(data).returning('*');
  return row;
}

export async function updateSettings(id: number, settings: GymSettings): Promise<GymRow> {
  const [row] = await db('gyms')
    .where({ id })
    .update({ settings: JSON.stringify(settings) })
    .returning('*');
  return row;
}

/**
 * The gym's settings as the rest of the server should see them: the owner's
 * stored preferences, narrowed by what the platform currently allows.
 *
 * Camera is the only setting an entitlement can override today, and folding it
 * in here rather than at each call site means every existing consumer — the
 * decision engine, the absence-nudge job, the enrol flow, the monitor's
 * /settings payload — respects a revocation without changes of its own.
 *
 * The owner's raw `camera_enabled` is left untouched in the JSONB, so
 * restoring the entitlement restores their original choice rather than
 * silently turning a camera on for a gym that had switched it off.
 */
export function getSettings(gym: GymRow): GymSettings {
  const settings = { ...DEFAULT_SETTINGS, ...gym.settings };
  if (!gym.camera_allowed) settings.camera_enabled = false;
  return settings;
}

/** Platform-owner-only. See the 20260822000008 migration. */
export async function setFeatures(id: number, features: Partial<GymFeatures>): Promise<GymRow> {
  const [row] = await db('gyms').where({ id }).update(features).returning('*');
  return row;
}

export async function listAll(): Promise<GymRow[]> {
  return db('gyms').select('*');
}

/** Permanent exemption from the subscription paywall (see billingService.hasAccess). */
export async function setComped(id: number, comped: boolean): Promise<void> {
  await db('gyms').where({ id }).update({ comped });
}

/**
 * The 403 body a frozen gym's owner actually reads.
 *
 * Three call sites reject a frozen gym — login, refresh and every
 * authenticated request — and each has to carry the admin's reason, or the
 * owner sees a different story depending on which one fired first. Built here
 * so they cannot drift.
 *
 * The reason is the whole point: the freeze alert used to travel only by
 * Telegram and email, both best effort, so an owner with no linked chat and a
 * bounced email was locked out with no explanation at all.
 */
export function frozenMessage(gym: Pick<GymRow, 'freeze_note'>): string {
  const note = gym.freeze_note?.trim();
  if (!note) return 'This gym account has been frozen by the platform. Please contact support.';
  return (
    'This gym account has been frozen by the platform.\n\n' +
    `Reason: ${note}\n\n` +
    'Contact the platform administrator to restore access.'
  );
}
