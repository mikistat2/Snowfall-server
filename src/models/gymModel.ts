import type { Knex } from 'knex';
import { db } from '../db/knex';
import { DEFAULT_SETTINGS, type GymFeatures, type GymRow, type GymSettings } from '../types';

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
