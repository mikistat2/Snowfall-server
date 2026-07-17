import type { Knex } from 'knex';
import { db } from '../db/knex';
import { DEFAULT_SETTINGS, type GymRow, type GymSettings } from '../types';

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

export function getSettings(gym: GymRow): GymSettings {
  return { ...DEFAULT_SETTINGS, ...gym.settings };
}

export async function listAll(): Promise<GymRow[]> {
  return db('gyms').select('*');
}
