import type { Knex } from 'knex';
import { db } from '../db/knex';

export interface GuestRow {
  id: number;
  gym_id: number;
  name: string;
  descriptor: number[] | null;
  valid_until: Date;
  created_by: number;
  converted_member_id: number | null;
  created_at: Date;
}

export async function create(
  data: {
    gym_id: number;
    name: string;
    descriptor: number[] | null;
    valid_until: Date;
    created_by: number;
  },
  trx: Knex = db,
): Promise<GuestRow> {
  const [row] = await trx('guests').insert(data).returning('*');
  return row;
}

export async function findById(gymId: number, id: number): Promise<GuestRow | undefined> {
  return db('guests').where({ gym_id: gymId, id }).first();
}

export async function listByGym(
  gymId: number,
  limit = 100,
): Promise<(GuestRow & { created_by_name: string; converted_member_name: string | null })[]> {
  return db('guests as g')
    .join('users as u', 'u.id', 'g.created_by')
    .leftJoin('members as m', 'm.id', 'g.converted_member_id')
    .where('g.gym_id', gymId)
    .select('g.*', 'u.name as created_by_name', 'm.full_name as converted_member_name')
    .orderBy('g.created_at', 'desc')
    .limit(limit);
}

/** Recognition cache: guests with a live pass and a stored descriptor. */
export async function listActiveDescriptors(
  gymId: number,
): Promise<{ guest_id: number; name: string; valid_until: Date; descriptor: number[] }[]> {
  const rows: GuestRow[] = await db('guests')
    .where({ gym_id: gymId })
    .whereNotNull('descriptor')
    .where('valid_until', '>=', db.fn.now())
    .select('*');
  return rows.map((g) => ({
    guest_id: g.id,
    name: g.name,
    valid_until: g.valid_until,
    descriptor: g.descriptor!,
  }));
}

export async function expireNow(gymId: number, id: number): Promise<GuestRow | undefined> {
  const [row] = await db('guests')
    .where({ gym_id: gymId, id })
    .update({ valid_until: new Date(), descriptor: null })
    .returning('*');
  return row;
}

export async function setConvertedMember(gymId: number, id: number, memberId: number): Promise<void> {
  await db('guests').where({ gym_id: gymId, id }).update({ converted_member_id: memberId });
}

/** Cron: drop stored face data once the pass has expired (privacy). */
export async function purgeExpiredDescriptors(): Promise<number> {
  return db('guests')
    .whereNotNull('descriptor')
    .where('valid_until', '<', db.fn.now())
    .update({ descriptor: null });
}
