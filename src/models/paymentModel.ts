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
    /**
     * Only set when back-filling a payment that was made before the system
     * existed — a historical amount must not land in this month's revenue.
     */
    created_at?: string | Date;
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

/**
 * Count and sum for the same filter `list` is showing, over every matching row
 * rather than the page on screen.
 *
 * The payments page exists to answer "how much came in": before the list was
 * paged, it summed the rows it had, which happened to be all of them. Summing
 * a page instead would quietly turn the headline figure into the total of the
 * most recent thirty payments — the kind of wrong number a gym owner would act
 * on. Postgres does the arithmetic over the whole filtered set, which is one
 * cheap indexed aggregate and cannot drift from the list beside it.
 */
export async function summary(
  gymId: number,
  filter: { from?: string; to?: string; method?: PaymentMethod; member_id?: number } = {},
): Promise<{ count: number; total: number }> {
  const q = db('payments as pay').where('pay.gym_id', gymId);
  if (filter.from) q.andWhere('pay.created_at', '>=', filter.from);
  if (filter.to) q.andWhere('pay.created_at', '<', `${filter.to}T23:59:59.999`);
  if (filter.method) q.andWhere('pay.method', filter.method);
  if (filter.member_id) q.andWhere('pay.member_id', filter.member_id);

  const row = await q
    .count<{ count: string; total: string | null }>('pay.id as count')
    .sum('pay.amount as total')
    .first();
  return { count: Number(row?.count ?? 0), total: Number(row?.total ?? 0) };
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
