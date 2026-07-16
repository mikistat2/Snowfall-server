import { db } from '../db/knex';
import * as gymModel from '../models/gymModel';
import * as memberModel from '../models/memberModel';
import * as planModel from '../models/planModel';
import * as subscriptionModel from '../models/subscriptionModel';
import * as paymentModel from '../models/paymentModel';
import * as eventModel from '../models/eventModel';
import * as auditLogModel from '../models/auditLogModel';
import { computeRenewal } from './decisionEngine';
import { recomputeMemberStatus } from './statusService';
import { emitToGym } from '../sockets';
import { notFound } from '../utils/errors';
import type { PaymentMethod } from '../types';

/**
 * Renewal: new expiry = max(today, current expiry) + plan.duration_days.
 * Same plan → extend the existing subscription; different plan → new
 * subscription row (keeps plan history readable). Payment row is immutable.
 */
export async function renew(input: {
  gymId: number;
  memberId: number;
  planId: number;
  amount?: number;
  method: PaymentMethod;
  note?: string;
  userId: number;
}): Promise<{ paymentId: number; expiresAt: string; status: string }> {
  const gym = await gymModel.findById(input.gymId);
  if (!gym) throw notFound('Gym not found');
  const settings = gymModel.getSettings(gym);

  const result = await db.transaction(async (trx) => {
    const member = await memberModel.findById(input.gymId, input.memberId, trx);
    if (!member) throw notFound('Member not found');
    const plan = await planModel.findById(input.gymId, input.planId);
    if (!plan) throw notFound('Plan not found');

    const current = await subscriptionModel.findLatestByMember(input.memberId, trx);
    const { startsAt, expiresAt } = computeRenewal(current?.expires_at ?? null, new Date(), plan.duration_days);

    let subscriptionId: number;
    if (current && current.plan_id === plan.id) {
      await subscriptionModel.update(
        current.id,
        { expires_at: expiresAt, status: 'active', frozen_at: null, frozen_days_remaining: null },
        trx,
      );
      subscriptionId = current.id;
    } else {
      const created = await subscriptionModel.create(
        {
          gym_id: input.gymId,
          member_id: input.memberId,
          plan_id: plan.id,
          starts_at: startsAt,
          expires_at: expiresAt,
        },
        trx,
      );
      subscriptionId = created.id;
    }

    const payment = await paymentModel.create(
      {
        gym_id: input.gymId,
        member_id: input.memberId,
        subscription_id: subscriptionId,
        amount: input.amount ?? Number(plan.price),
        method: input.method,
        marked_by: input.userId,
        note: input.note ?? null,
      },
      trx,
    );

    const status = await recomputeMemberStatus(input.memberId, settings, trx);

    await auditLogModel.log(
      {
        gym_id: input.gymId,
        user_id: input.userId,
        action: 'payment.marked',
        entity: 'payment',
        entity_id: payment.id,
        meta: { member_id: input.memberId, plan_id: plan.id, amount: payment.amount, method: input.method },
      },
      trx,
    );

    return { payment, member, plan, expiresAt, status };
  });

  const event = await eventModel.create({
    gym_id: input.gymId,
    type: 'payment',
    severity: 'green',
    message: `${result.member.full_name} — renewed ${result.plan.name} · valid until ${result.expiresAt}`,
    member_id: input.memberId,
  });
  emitToGym(input.gymId, 'event:new', event);

  // a just-renewed member must not ride a cached "denied" decision at the door
  const { clearDebounce } = await import('./checkInService');
  clearDebounce(input.gymId, input.memberId);

  // Telegram receipt (fire-and-forget; logged in notifications either way)
  void import('./notificationService').then((s) =>
    s
      .sendReceipt({
        gymId: input.gymId,
        memberId: input.memberId,
        amount: result.payment.amount,
        planName: result.plan.name,
        expiresAt: result.expiresAt,
        gymName: gym.name,
      })
      .catch(() => undefined),
  );

  return { paymentId: result.payment.id, expiresAt: result.expiresAt, status: result.status };
}
