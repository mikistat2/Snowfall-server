import type { Knex } from 'knex';
import { db } from '../db/knex';
import type { PaymentMethod } from '../types';

export interface PaymentRow {
  id: number;
  gym_id: number;
  member_id: number;
  subscription_id: number;
  amount: string;
  method: PaymentMethod;
  marked_by: number;
  note: string | null;
  created_at: Date;
}

export async function create(
  data: {
    gym_id: number;
    member_id: number;
    subscription_id: number;
    amount: number;
    method: PaymentMethod;
    marked_by: number;
    note?: string | null;
  },
  trx: Knex = db,
): Promise<PaymentRow> {
  const [row] = await trx('payments').insert(data).returning('*');
  return row;
}

export async function list(
  gymId: number,
  filter: { from?: string; to?: string; method?: PaymentMethod; member_id?: number; offset?: number } = {},
  limit = 200,
): Promise<(PaymentRow & { member_name: string; marked_by_name: string })[]> {
  const q = db('payments as pay')
    .join('members as m', 'm.id', 'pay.member_id')
    .join('users as u', 'u.id', 'pay.marked_by')
    .where('pay.gym_id', gymId)
    .select('pay.*', 'm.full_name as member_name', 'u.name as marked_by_name')
    .orderBy('pay.created_at', 'desc')
    .limit(limit);
  if (filter.from) q.andWhere('pay.created_at', '>=', filter.from);
  if (filter.to) q.andWhere('pay.created_at', '<', `${filter.to}T23:59:59.999`);
  if (filter.method) q.andWhere('pay.method', filter.method);
  if (filter.member_id) q.andWhere('pay.member_id', filter.member_id);
  if (filter.offset != null) q.offset(filter.offset);
  return q;
}

export async function listByMember(memberId: number): Promise<PaymentRow[]> {
  return db('payments').where({ member_id: memberId }).orderBy('created_at', 'desc');
}

export async function revenueSince(gymId: number, since: Date): Promise<number> {
  const row = await db('payments')
    .where({ gym_id: gymId })
    .where('created_at', '>=', since)
    .sum<{ sum: string | null }>('amount as sum')
    .first();
  return Number(row?.sum ?? 0);
}
