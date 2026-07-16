import { db } from '../db/knex';
import * as gymModel from '../models/gymModel';
import * as memberModel from '../models/memberModel';
import * as planModel from '../models/planModel';
import * as subscriptionModel from '../models/subscriptionModel';
import * as paymentModel from '../models/paymentModel';
import * as auditLogModel from '../models/auditLogModel';
import { recomputeMemberStatus } from './statusService';
import { clearDebounce } from './checkInService';
import { addDays, dateOnly, daysBetween } from '../utils/dates';
import { badRequest, notFound } from '../utils/errors';
import type { MemberRow, PaymentMethod } from '../types';

/**
 * Enrollment: member + face descriptors + first subscription + first payment,
 * all in one transaction so a half-enrolled member can never exist.
 */
export async function enroll(input: {
  gymId: number;
  userId: number;
  member: { full_name: string; phone?: string; sex?: 'male' | 'female'; photo_url?: string | null };
  descriptors: number[][];
  planId: number;
  payment: { amount?: number; method: PaymentMethod; note?: string };
}): Promise<MemberRow> {
  const gym = await gymModel.findById(input.gymId);
  if (!gym) throw notFound('Gym not found');
  const settings = gymModel.getSettings(gym);

  if (input.descriptors.some((d) => d.length !== 128)) {
    throw badRequest('Each face descriptor must have 128 values');
  }

  return db.transaction(async (trx) => {
    const plan = await planModel.findById(input.gymId, input.planId);
    if (!plan || !plan.active) throw badRequest('Plan not found or inactive');

    const member = await memberModel.create(input.gymId, input.member, trx);
    if (input.descriptors.length > 0) {
      await memberModel.addDescriptors(member.id, input.descriptors, trx);
    }

    const startsAt = dateOnly(new Date());
    const subscription = await subscriptionModel.create(
      {
        gym_id: input.gymId,
        member_id: member.id,
        plan_id: plan.id,
        starts_at: startsAt,
        expires_at: addDays(startsAt, plan.duration_days),
      },
      trx,
    );

    await paymentModel.create(
      {
        gym_id: input.gymId,
        member_id: member.id,
        subscription_id: subscription.id,
        amount: input.payment.amount ?? Number(plan.price),
        method: input.payment.method,
        marked_by: input.userId,
        note: input.payment.note ?? 'Enrollment',
      },
      trx,
    );

    const status = await recomputeMemberStatus(member.id, settings, trx);
    await auditLogModel.log(
      {
        gym_id: input.gymId,
        user_id: input.userId,
        action: 'member.enrolled',
        entity: 'member',
        entity_id: member.id,
        meta: { plan_id: plan.id, descriptors: input.descriptors.length },
      },
      trx,
    );

    return { ...member, status };
  });
}

/** Freeze: remember how many days are left; expiry stops mattering until unfreeze. */
export async function freeze(gymId: number, memberId: number, userId: number): Promise<void> {
  const member = await memberModel.findById(gymId, memberId);
  if (!member) throw notFound('Member not found');
  const sub = await subscriptionModel.findLatestByMember(memberId);
  if (!sub) throw badRequest('Member has no subscription to freeze');
  if (sub.status === 'frozen') throw badRequest('Already frozen');

  const remaining = Math.max(0, daysBetween(dateOnly(new Date()), sub.expires_at));
  await db.transaction(async (trx) => {
    await subscriptionModel.update(
      sub.id,
      { status: 'frozen', frozen_at: new Date(), frozen_days_remaining: remaining },
      trx,
    );
    await memberModel.setStatus(memberId, 'frozen', trx);
    await auditLogModel.log(
      { gym_id: gymId, user_id: userId, action: 'member.frozen', entity: 'member', entity_id: memberId, meta: { remaining } },
      trx,
    );
  });
  clearDebounce(gymId, memberId); // deny at the door immediately
}

/** Unfreeze: expiry = today + stored remaining days. */
export async function unfreeze(gymId: number, memberId: number, userId: number): Promise<void> {
  const gym = await gymModel.findById(gymId);
  if (!gym) throw notFound('Gym not found');
  const member = await memberModel.findById(gymId, memberId);
  if (!member) throw notFound('Member not found');
  const sub = await subscriptionModel.findLatestByMember(memberId);
  if (!sub || sub.status !== 'frozen') throw badRequest('Member is not frozen');

  const expiresAt = addDays(dateOnly(new Date()), sub.frozen_days_remaining ?? 0);
  await db.transaction(async (trx) => {
    await subscriptionModel.update(
      sub.id,
      { status: 'active', expires_at: expiresAt, frozen_at: null, frozen_days_remaining: null },
      trx,
    );
    await recomputeMemberStatus(memberId, gymModel.getSettings(gym), trx);
    await auditLogModel.log(
      { gym_id: gymId, user_id: userId, action: 'member.unfrozen', entity: 'member', entity_id: memberId, meta: { expiresAt } },
      trx,
    );
  });
  clearDebounce(gymId, memberId); // allow at the door immediately
}

/** Full member detail for the member page. */
export async function detail(gymId: number, memberId: number) {
  const member = await memberModel.findById(gymId, memberId);
  if (!member) throw notFound('Member not found');

  const [subscriptions, payments, checkIns, descriptors] = await Promise.all([
    subscriptionModel.listByMember(memberId),
    paymentModel.listByMember(memberId),
    import('../models/checkInModel').then((m) => m.listRecentByMember(memberId)),
    memberModel.descriptorCount(memberId),
  ]);

  return { member, subscriptions, payments, check_ins: checkIns, descriptor_count: descriptors };
}
