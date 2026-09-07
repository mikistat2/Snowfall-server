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
  /** Non-null once struck through. Voided rows still show; they never count. */
  voided_at: Date | null;
  voided_by: number | null;
  void_reason: string | null;
  /** The voided payment this row replaces, when it is a correction. */
  corrects_id: number | null;
}

/**
 * The one predicate that separates a ledger from a total.
 *
 * Every list shows voided rows — a payment that vanishes is indistinguishable
 * from one that was never taken, and the gym would go looking for it. Every
 * sum excludes them. Named once so the two can never drift apart.
 */
export const LIVE = { voided_at: null } as const;

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
     * A correction sets it too, to the voided row's date, for the same reason.
     */
    created_at?: string | Date;
    /** The voided payment this row replaces. Set only by paymentService.amend. */
    corrects_id?: number;
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
): Promise<(PaymentRow & { member_name: string; marked_by_name: string; voided_by_name: string | null })[]> {
  const q = db('payments as pay')
    .join('members as m', 'm.id', 'pay.member_id')
    .join('users as u', 'u.id', 'pay.marked_by')
    // LEFT, and a second join to the same table: almost no row is voided, and
    // an inner join here would hide every payment that is not.
    .leftJoin('users as v', 'v.id', 'pay.voided_by')
    .where('pay.gym_id', gymId)
    .select('pay.*', 'm.full_name as member_name', 'u.name as marked_by_name', 'v.name as voided_by_name')
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
  // The headline figure the gym owner acts on. A voided row is a correction of
  // the record, not money taken, so it must not be in it.
  q.whereNull('pay.voided_at');

  const row = await q
    .count<{ count: string; total: string | null }>('pay.id as count')
    .sum('pay.amount as total')
    .first();
  return { count: Number(row?.count ?? 0), total: Number(row?.total ?? 0) };
}

export async function listByMember(memberId: number): Promise<PaymentRow[]> {
  return db('payments').where({ member_id: memberId }).orderBy('created_at', 'desc');
}

export async function findById(gymId: number, id: number): Promise<PaymentRow | undefined> {
  return db('payments').where({ gym_id: gymId, id }).first();
}

/**
 * Strike a payment through. Returns 0 when it was already voided or is not
 * this gym's, so a double-click cannot overwrite the first void's reason and
 * author — the database refuses that too, but a caller should not have to
 * catch an exception to learn it.
 *
 * `whereNull('voided_at')` is what makes this safe to race: the row lock makes
 * exactly one of two concurrent voids the winner.
 */
export async function markVoided(
  gymId: number,
  id: number,
  userId: number,
  reason: string,
  trx: Knex = db,
): Promise<number> {
  return trx('payments')
    .where({ gym_id: gymId, id })
    .whereNull('voided_at')
    .update({ voided_at: trx.fn.now(), voided_by: userId, void_reason: reason });
}

export async function revenueSince(gymId: number, since: Date): Promise<number> {
  const row = await db('payments')
    .where({ gym_id: gymId })
    .where(LIVE)
    .where('created_at', '>=', since)
    .sum<{ sum: string | null }>('amount as sum')
    .first();
  return Number(row?.sum ?? 0);
}
