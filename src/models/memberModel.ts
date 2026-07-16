import type { Knex } from 'knex';
import { db } from '../db/knex';
import type { MemberRow, MemberStatus } from '../types';

export interface MemberInput {
  full_name: string;
  phone?: string | null;
  sex?: 'male' | 'female' | null;
  photo_url?: string | null;
}

export async function listByGym(
  gymId: number,
  filter: { search?: string; status?: MemberStatus } = {},
): Promise<(MemberRow & { plan_name: string | null; expires_at: Date | null })[]> {
  const q = db('members as m')
    .where('m.gym_id', gymId)
    .leftJoin(
      db('subscriptions')
        .select('member_id', 'plan_id', 'expires_at')
        .distinctOn('member_id')
        .orderBy(['member_id', { column: 'expires_at', order: 'desc' }])
        .as('s'),
      's.member_id',
      'm.id',
    )
    .leftJoin('plans as p', 'p.id', 's.plan_id')
    .select('m.*', 'p.name as plan_name', 's.expires_at')
    .orderBy('m.full_name');
  if (filter.status) q.andWhere('m.status', filter.status);
  if (filter.search) {
    q.andWhere((b) =>
      b.whereILike('m.full_name', `%${filter.search}%`).orWhereILike('m.phone', `%${filter.search}%`),
    );
  }
  return q;
}

export async function findById(gymId: number, id: number, trx: Knex = db): Promise<MemberRow | undefined> {
  return trx('members').where({ gym_id: gymId, id }).first();
}

export async function create(gymId: number, data: MemberInput, trx: Knex = db): Promise<MemberRow> {
  const [row] = await trx('members').insert({ ...data, gym_id: gymId }).returning('*');
  return row;
}

export async function update(
  gymId: number,
  id: number,
  data: Partial<MemberInput>,
  trx: Knex = db,
): Promise<MemberRow | undefined> {
  const [row] = await trx('members').where({ gym_id: gymId, id }).update(data).returning('*');
  return row;
}

export async function setStatus(id: number, status: MemberStatus, trx: Knex = db): Promise<void> {
  await trx('members').where({ id }).update({ status });
}

/** All descriptors for a gym's non-expired-beyond-recognition members (monitor cache). */
export async function listDescriptorsByGym(gymId: number): Promise<
  { member_id: number; full_name: string; status: MemberStatus; descriptors: number[][] }[]
> {
  const rows: { member_id: number; full_name: string; status: MemberStatus; descriptor: number[] }[] =
    await db('face_descriptors as fd')
      .join('members as m', 'm.id', 'fd.member_id')
      .where('m.gym_id', gymId)
      .select('fd.member_id', 'm.full_name', 'm.status', 'fd.descriptor');

  const byMember = new Map<number, { member_id: number; full_name: string; status: MemberStatus; descriptors: number[][] }>();
  for (const r of rows) {
    const entry = byMember.get(r.member_id) ?? {
      member_id: r.member_id,
      full_name: r.full_name,
      status: r.status,
      descriptors: [],
    };
    entry.descriptors.push(r.descriptor);
    byMember.set(r.member_id, entry);
  }
  return [...byMember.values()];
}

export async function addDescriptors(memberId: number, descriptors: number[][], trx: Knex = db): Promise<void> {
  await trx('face_descriptors').insert(descriptors.map((d) => ({ member_id: memberId, descriptor: d })));
}

export async function clearDescriptors(memberId: number, trx: Knex = db): Promise<void> {
  await trx('face_descriptors').where({ member_id: memberId }).delete();
}

export async function setLinkToken(gymId: number, memberId: number, token: string): Promise<void> {
  await db('members').where({ gym_id: gymId, id: memberId }).update({ telegram_link_token: token });
}

export async function findByLinkToken(token: string): Promise<MemberRow | undefined> {
  return db('members').where({ telegram_link_token: token }).first();
}

export async function bindTelegram(
  memberId: number,
  chatId: number,
  username: string | null,
): Promise<void> {
  await db('members')
    .where({ id: memberId })
    .update({ telegram_chat_id: chatId, telegram_username: username, telegram_link_token: null });
}

export async function descriptorCount(memberId: number): Promise<number> {
  const row = await db('face_descriptors').where({ member_id: memberId }).count<{ count: string }>('id as count').first();
  return Number(row?.count ?? 0);
}
