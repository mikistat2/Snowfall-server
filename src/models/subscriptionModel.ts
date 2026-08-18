import type { Knex } from 'knex';
import { db } from '../db/knex';
import type { SubscriptionRow, SubscriptionStatus } from '../types';

/** Latest subscription (by expiry) for a member. */
export async function findLatestByMember(memberId: number, trx: Knex = db): Promise<SubscriptionRow | undefined> {
  return trx('subscriptions').where({ member_id: memberId }).orderBy('expires_at', 'desc').first();
}

export async function listByMember(memberId: number): Promise<(SubscriptionRow & { plan_name: string })[]> {
  return db('subscriptions as s')
    .join('plans as p', 'p.id', 's.plan_id')
    .where('s.member_id', memberId)
    .select('s.*', 'p.name as plan_name')
    .orderBy('s.expires_at', 'desc');
}

export async function create(
  data: {
    gym_id: number;
    member_id: number;
    plan_id: number;
    starts_at: string;
    expires_at: string;
    status?: SubscriptionStatus;
  },
  trx: Knex = db,
): Promise<SubscriptionRow> {
  const [row] = await trx('subscriptions').insert(data).returning('*');
  return row;
}

export async function update(
  id: number,
  patch: Partial<{
    plan_id: number;
    starts_at: string;
    expires_at: string;
    status: SubscriptionStatus;
    frozen_at: Date | null;
    frozen_days_remaining: number | null;
  }>,
  trx: Knex = db,
): Promise<SubscriptionRow> {
  const [row] = await trx('subscriptions').where({ id }).update(patch).returning('*');
  return row;
}

/** Latest subscription + plan for the check-in decision. */
export async function findCurrentWithPlan(
  memberId: number,
): Promise<
  | (SubscriptionRow & {
      plan_name: string;
      sessions_per_day: number | null;
      allowed_hours: string | null;
      duration_days: number;
    })
  | undefined
> {
  return db('subscriptions as s')
    .join('plans as p', 'p.id', 's.plan_id')
    .where('s.member_id', memberId)
    .select(
      's.*',
      'p.name as plan_name',
      'p.sessions_per_day',
      'p.allowed_hours',
      'p.duration_days',
    )
    .orderBy('s.expires_at', 'desc')
    .first();
}

/** Latest subscription per member with member contact info (reminder cron). */
export async function listLatestWithMemberForGym(gymId: number): Promise<
  {
    member_id: number;
    full_name: string;
    telegram_chat_id: number | null;
    member_status: string;
    expires_at: string;
    sub_status: SubscriptionStatus;
  }[]
> {
  return db('subscriptions as s')
    .distinctOn('s.member_id')
    .join('members as m', 'm.id', 's.member_id')
    .where('s.gym_id', gymId)
    .whereNull('m.archived_at') // no reminders to someone who left the gym
    .select(
      's.member_id',
      'm.full_name',
      'm.telegram_chat_id',
      'm.status as member_status',
      's.expires_at',
      's.status as sub_status',
    )
    .orderBy(['s.member_id', { column: 's.expires_at', order: 'desc' }]);
}

/** All non-frozen members of a gym with their latest subscription (for status recompute). */
export async function listLatestForGym(
  gymId: number,
): Promise<{ member_id: number; member_status: string; subscription_id: number; expires_at: string; sub_status: SubscriptionStatus }[]> {
  return db('subscriptions as s')
    .distinctOn('s.member_id')
    .join('members as m', 'm.id', 's.member_id')
    .where('s.gym_id', gymId)
    .whereNull('m.archived_at') // frozen in time until restored
    .select(
      's.member_id',
      'm.status as member_status',
      's.id as subscription_id',
      's.expires_at',
      's.status as sub_status',
    )
    .orderBy(['s.member_id', { column: 's.expires_at', order: 'desc' }]);
}
