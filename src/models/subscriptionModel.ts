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

// ------------------------------------------------------- expiry reminders --

/** The three points in a period a member can be messaged about, in order. */
export const REMINDER_MILESTONES = ['ahead', 'due', 'grace'] as const;
export type ReminderMilestone = (typeof REMINDER_MILESTONES)[number];

const MILESTONE_COLUMN: Record<ReminderMilestone, string> = {
  ahead: 'reminded_ahead_at',
  due: 'reminded_due_at',
  grace: 'reminded_grace_at',
};

export interface ReminderCandidate {
  subscription_id: number;
  member_id: number;
  full_name: string;
  telegram_chat_id: number | null;
  expires_at: string;
  reminded_ahead_at: Date | null;
  reminded_due_at: Date | null;
  reminded_grace_at: Date | null;
}

/**
 * Members whose latest subscription is close enough to its end to be worth a
 * message, from `aheadDays` before expiry to `catchUpDays` after it.
 *
 * The "latest per member" step happens BEFORE the date window, not after. The
 * other way round looks equivalent and is not: a member who renewed early has
 * both an old expiring row and a new distant one, and filtering first would
 * drop the new row out of the window and leave DISTINCT ON to pick the old
 * one — telling somebody who has just paid that their membership has run out.
 *
 * The trailing edge is what makes a first deploy safe: members who lapsed
 * months ago are excluded in SQL, so switching catch-up on cannot dredge up a
 * backlog of ancient expiries.
 */
export async function listReminderCandidates(
  gymId: number,
  aheadDays: number,
  catchUpDays: number,
): Promise<ReminderCandidate[]> {
  const latest = db('subscriptions as s')
    .distinctOn('s.member_id')
    .where('s.gym_id', gymId)
    .select('s.*')
    .orderBy(['s.member_id', { column: 's.expires_at', order: 'desc' }]);

  return db
    .from(latest.as('l'))
    .join('members as m', 'm.id', 'l.member_id')
    .whereNull('m.archived_at') // no reminders to someone who left the gym
    .whereNot('l.status', 'frozen')
    .whereRaw('l.expires_at >= (now()::date - ?::int)', [catchUpDays])
    .whereRaw('l.expires_at <= (now()::date + ?::int)', [aheadDays])
    .select(
      'l.id as subscription_id',
      'l.member_id',
      'l.expires_at',
      'l.reminded_ahead_at',
      'l.reminded_due_at',
      'l.reminded_grace_at',
      'm.full_name',
      'm.telegram_chat_id',
    );
}

/**
 * Stamps every milestone up to and including `milestone`.
 *
 * The ones being skipped matter as much as the one just sent. A member the
 * server was asleep for is three messages behind; they should get today's
 * truth once, not a backlog of three. Closing the earlier milestones is what
 * stops tomorrow's run from delivering yesterday's news.
 *
 * COALESCE keeps whatever was already there, so a re-run never rewrites the
 * date a message actually went out.
 */
export async function markReminded(
  subscriptionId: number,
  milestone: ReminderMilestone,
  at: Date,
): Promise<void> {
  const upTo = REMINDER_MILESTONES.slice(0, REMINDER_MILESTONES.indexOf(milestone) + 1);
  const patch: Record<string, unknown> = {};
  for (const m of upTo) {
    const column = MILESTONE_COLUMN[m];
    patch[column] = db.raw('COALESCE(??, ?)', [column, at]);
  }
  await db('subscriptions').where({ id: subscriptionId }).update(patch);
}
