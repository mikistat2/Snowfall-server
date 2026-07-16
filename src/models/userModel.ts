import type { Knex } from 'knex';
import { db } from '../db/knex';
import type { UserRow } from '../types';

export async function findByEmail(email: string): Promise<UserRow | undefined> {
  return db('users').whereRaw('lower(email) = lower(?)', [email]).first();
}

export async function findById(id: number): Promise<UserRow | undefined> {
  return db('users').where({ id }).first();
}

export async function listByGym(gymId: number): Promise<Omit<UserRow, 'password_hash'>[]> {
  return db('users')
    .where({ gym_id: gymId })
    .select('id', 'gym_id', 'name', 'phone', 'email', 'role', 'created_at')
    .orderBy('id');
}

export async function create(
  data: {
    gym_id: number;
    name: string;
    phone?: string | null;
    email: string;
    password_hash: string;
    role: 'owner' | 'staff';
  },
  trx: Knex = db,
): Promise<UserRow> {
  const [row] = await trx('users').insert(data).returning('*');
  return row;
}

export async function remove(gymId: number, id: number): Promise<number> {
  return db('users').where({ gym_id: gymId, id }).delete();
}

export async function setLinkToken(gymId: number, userId: number, token: string): Promise<void> {
  await db('users').where({ gym_id: gymId, id: userId }).update({ telegram_link_token: token });
}

export async function findByLinkToken(token: string): Promise<UserRow | undefined> {
  return db('users').where({ telegram_link_token: token }).first();
}

export async function bindTelegram(userId: number, chatId: number): Promise<void> {
  await db('users').where({ id: userId }).update({ telegram_chat_id: chatId, telegram_link_token: null });
}

/** Owner chat ids for a gym (admin alerts / daily summary). */
export async function ownerChatIds(gymId: number): Promise<number[]> {
  const rows: { telegram_chat_id: number }[] = await db('users')
    .where({ gym_id: gymId, role: 'owner' })
    .whereNotNull('telegram_chat_id')
    .select('telegram_chat_id');
  return rows.map((r) => Number(r.telegram_chat_id));
}
