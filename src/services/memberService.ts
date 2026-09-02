import { db } from '../db/knex';
import * as gymModel from '../models/gymModel';
import * as memberModel from '../models/memberModel';
import * as planModel from '../models/planModel';
import * as subscriptionModel from '../models/subscriptionModel';
import * as paymentModel from '../models/paymentModel';
import * as auditLogModel from '../models/auditLogModel';
import { recomputeMemberStatus } from './statusService';
import { clearDebounce } from './checkInService';
import * as memberPhotoService from './memberPhotoService';
import { addDays, dateAtNoonUtc, dateOnly, dateOnlyUtc, daysBetween } from '../utils/dates';
import { toGregorianDateOnly, type CalendarSystem } from '../utils/ethiopian';
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
  /** `amount` is required: the till figure is stated, never inferred from the plan. */
  payment: { amount: number; method: PaymentMethod; note?: string };
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
        amount: input.payment.amount,
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

/**
 * Back-fill a member who was already training before the system was installed.
 *
 * Differences from `enroll`, all of them consequences of the record coming off
 * a paper register rather than from someone standing at the desk:
 *  - the dates are given, not "today" — and may be written in the Ethiopian
 *    calendar, so they are converted here before anything is stored;
 *  - the subscription period is the one already running (or already over), so
 *    an overdue paper member lands as `grace`/`expired` on the very first
 *    status recompute and is refused at the door until someone renews them;
 *  - the payment is historical and optional: it is stamped with the date it was
 *    actually taken, so back-filling a hundred members cannot fake a spike in
 *    this month's revenue;
 *  - face captures are optional, since the member is rarely present while their
 *    paper record is being typed in.
 */
export async function enrollPrevious(input: {
  gymId: number;
  userId: number;
  member: { full_name: string; phone?: string; sex?: 'male' | 'female'; photo_url?: string | null };
  descriptors: number[][];
  planId: number;
  calendar: CalendarSystem;
  /** What the clerk was reading, for the audit log — never used for conversion. */
  enteredCalendar?: CalendarSystem;
  /** All three are "YYYY-MM-DD" written in `calendar`. */
  joinedAt: string;
  startsAt: string;
  expiresAt?: string;
  /** Omitted = a pre-system payment that is not being recorded at all. */
  payment?: { amount: number; method: PaymentMethod; note?: string };
}): Promise<MemberRow> {
  const gym = await gymModel.findById(input.gymId);
  if (!gym) throw notFound('Gym not found');
  const settings = gymModel.getSettings(gym);

  if (input.descriptors.some((d) => d.length !== 128)) {
    throw badRequest('Each face descriptor must have 128 values');
  }

  const convert = (value: string, field: string): string => {
    const gregorian = toGregorianDateOnly(value, input.calendar);
    if (!gregorian) throw badRequest(`${field} is not a valid ${input.calendar} date`);
    return gregorian;
  };

  const joinedAt = convert(input.joinedAt, 'Registration date');
  const startsAt = convert(input.startsAt, 'Membership start date');
  const expiresOverride = input.expiresAt ? convert(input.expiresAt, 'Expiry date') : undefined;

  // A paper record is history: a future join date means the calendar toggle was
  // wrong (Ethiopian years read ~8 ahead), which is worth catching loudly.
  const today = dateOnly(new Date());
  if (daysBetween(today, joinedAt) > 0) throw badRequest('Registration date cannot be in the future');
  if (daysBetween(joinedAt, startsAt) < 0) {
    throw badRequest('Membership start date cannot be before the registration date');
  }
  if (expiresOverride && daysBetween(startsAt, expiresOverride) < 0) {
    throw badRequest('Expiry date cannot be before the membership start date');
  }

  return db.transaction(async (trx) => {
    const plan = await planModel.findById(input.gymId, input.planId);
    if (!plan || !plan.active) throw badRequest('Plan not found or inactive');

    const member = await memberModel.create(
      input.gymId,
      // joined_at is TIMESTAMPTZ: pin it to noon UTC so the calendar day cannot
      // slip when Postgres and the API disagree about the local timezone
      { ...input.member, joined_at: dateAtNoonUtc(joinedAt) },
      trx,
    );
    if (input.descriptors.length > 0) {
      await memberModel.addDescriptors(member.id, input.descriptors, trx);
    }

    const expiresAt = expiresOverride ?? addDays(startsAt, plan.duration_days);
    const subscription = await subscriptionModel.create(
      {
        gym_id: input.gymId,
        member_id: member.id,
        plan_id: plan.id,
        starts_at: startsAt,
        expires_at: expiresAt,
      },
      trx,
    );

    if (input.payment) {
      await paymentModel.create(
        {
          gym_id: input.gymId,
          member_id: member.id,
          subscription_id: subscription.id,
          amount: input.payment.amount,
          method: input.payment.method,
          marked_by: input.userId,
          note: input.payment.note ?? 'Previous member (paper record)',
          created_at: dateAtNoonUtc(startsAt),
        },
        trx,
      );
    }

    const status = await recomputeMemberStatus(member.id, settings, trx);
    await auditLogModel.log(
      {
        gym_id: input.gymId,
        user_id: input.userId,
        action: 'member.enrolled_previous',
        entity: 'member',
        entity_id: member.id,
        meta: {
          plan_id: plan.id,
          descriptors: input.descriptors.length,
          calendar: input.calendar,
          entered_calendar: input.enteredCalendar ?? input.calendar,
          // what was typed off the paper, alongside what it was stored as
          entered: { joined_at: input.joinedAt, starts_at: input.startsAt, expires_at: input.expiresAt ?? null },
          stored: { joined_at: joinedAt, starts_at: startsAt, expires_at: expiresAt },
          payment_recorded: Boolean(input.payment),
        },
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

/**
 * Take a member off the roster without touching their money.
 *
 * They vanish from the members list, the door monitor's recognition cache, the
 * status cron and the reminder jobs, but every payment they ever made stays
 * exactly where it is — which is the only way to remove a paying member without
 * rewriting past revenue.
 */
export async function archive(gymId: number, memberId: number, userId: number): Promise<MemberRow> {
  const member = await memberModel.findById(gymId, memberId);
  if (!member) throw notFound('Member not found');
  if (member.archived_at) throw badRequest('Member is already archived');

  const updated = await memberModel.setArchived(gymId, memberId, true);
  await auditLogModel.log({
    gym_id: gymId,
    user_id: userId,
    action: 'member.archived',
    entity: 'member',
    entity_id: memberId,
    meta: { full_name: member.full_name },
  });
  clearDebounce(gymId, memberId); // deny at the door immediately
  return updated as MemberRow;
}

/** Put an archived member back on the roster, with their status recomputed. */
export async function restore(gymId: number, memberId: number, userId: number): Promise<MemberRow> {
  const gym = await gymModel.findById(gymId);
  if (!gym) throw notFound('Gym not found');
  const member = await memberModel.findById(gymId, memberId);
  if (!member) throw notFound('Member not found');
  if (!member.archived_at) throw badRequest('Member is not archived');

  const updated = await db.transaction(async (trx) => {
    const row = await memberModel.setArchived(gymId, memberId, false, trx);
    // the nightly cron skipped them while archived, so their stored status is
    // as stale as the day they left
    await recomputeMemberStatus(memberId, gymModel.getSettings(gym), trx);
    return row;
  });

  await auditLogModel.log({
    gym_id: gymId,
    user_id: userId,
    action: 'member.restored',
    entity: 'member',
    entity_id: memberId,
    meta: { full_name: member.full_name },
  });
  clearDebounce(gymId, memberId);
  return (await memberModel.findById(gymId, memberId)) ?? (updated as MemberRow);
}

/**
 * Permanent deletion — only for a member with no payment history, which in
 * practice means a mistake: a duplicate or a mistyped row from back-filling the
 * paper register. Anyone who has ever paid must be archived instead, because
 * `payments` is an immutable audit trail and deleting from it would silently
 * change past revenue figures.
 */
export async function remove(gymId: number, memberId: number, userId: number): Promise<void> {
  const member = await memberModel.findById(gymId, memberId);
  if (!member) throw notFound('Member not found');

  const payments = await memberModel.paymentCount(memberId);
  if (payments > 0) {
    throw badRequest(
      `This member has ${payments} recorded payment${payments === 1 ? '' : 's'}. ` +
        'Deleting them would change past income records — archive them instead.',
    );
  }

  await db.transaction(async (trx) => {
    await memberModel.hardDelete(gymId, memberId, trx);
    // the member row is gone, so the log keeps the name: entity_id alone would
    // point at nothing
    await auditLogModel.log(
      {
        gym_id: gymId,
        user_id: userId,
        action: 'member.deleted',
        entity: 'member',
        entity_id: memberId,
        meta: { full_name: member.full_name, phone: member.phone, joined_at: member.joined_at },
      },
      trx,
    );
  });
  clearDebounce(gymId, memberId);
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

  // One member, so the legacy inline photo is passed through as a fallback —
  // ~5 KB on a page that is already loading their whole history. The roster
  // deliberately does not do this; see memberPhotoService.photoUrls.
  return {
    member: { ...member, ...memberPhotoService.photoUrls(member) },
    subscriptions,
    payments,
    check_ins: checkIns,
    descriptor_count: descriptors,
  };
}

/**
 * Admin correction of an existing member.
 *
 * Two different kinds of change arrive through here, and they are deliberately
 * validated together rather than as two endpoints: fixing a misspelled name and
 * fixing the dates that name was typed in with are the same job to the person
 * doing it, and a start date can only be judged against the join date it is
 * being saved beside.
 *
 * The subscription half rewrites the member's *current* period in place. It
 * does not create a subscription, take a payment, or touch the payment history:
 * this is for a row that was entered wrong, not for a renewal — that is what
 * `paymentService.renew` is for, and it is the only thing that may move money.
 */
export async function updateMember(input: {
  gymId: number;
  userId: number;
  memberId: number;
  member?: Partial<{
    full_name: string;
    phone: string | null;
    sex: 'male' | 'female' | null;
    photo_url: string | null;
  }>;
  /** Gregorian "YYYY-MM-DD" — the controller has already converted the calendar. */
  joinedAt?: string;
  subscription?: { planId?: number; startsAt?: string; expiresAt?: string };
}): Promise<MemberRow> {
  const gym = await gymModel.findById(input.gymId);
  if (!gym) throw notFound('Gym not found');
  const settings = gymModel.getSettings(gym);

  const member = await memberModel.findById(input.gymId, input.memberId);
  if (!member) throw notFound('Member not found');

  const today = dateOnly(new Date());
  if (input.joinedAt && daysBetween(today, input.joinedAt) > 0) {
    throw badRequest('Registration date cannot be in the future');
  }
  // whichever join date the record will end up with, old or new
  const joinedAt = input.joinedAt ?? dateOnlyUtc(member.joined_at);

  await db.transaction(async (trx) => {
    const memberPatch: Record<string, unknown> = { ...input.member };
    if (input.joinedAt) memberPatch.joined_at = dateAtNoonUtc(input.joinedAt);
    if (Object.keys(memberPatch).length > 0) {
      await memberModel.update(input.gymId, input.memberId, memberPatch, trx);
    }

    if (input.subscription) {
      const sub = await subscriptionModel.findLatestByMember(input.memberId, trx);
      if (!sub) {
        throw badRequest('This member has no subscription yet — use Renew to give them one');
      }

      let planId = sub.plan_id;
      if (input.subscription.planId != null && input.subscription.planId !== sub.plan_id) {
        const plan = await planModel.findById(input.gymId, input.subscription.planId);
        if (!plan) throw badRequest('Plan not found');
        planId = plan.id;
      }

      const startsAt = input.subscription.startsAt ?? String(sub.starts_at).slice(0, 10);
      const expiresAt = input.subscription.expiresAt ?? String(sub.expires_at).slice(0, 10);
      if (daysBetween(joinedAt, startsAt) < 0) {
        throw badRequest('Membership start date cannot be before the registration date');
      }
      if (daysBetween(startsAt, expiresAt) < 0) {
        throw badRequest('Expiry date cannot be before the membership start date');
      }

      // A frozen membership is stored as "N days were left when it stopped".
      // Moving the expiry without moving that number would silently be undone
      // the moment someone unfreezes them.
      const frozenPatch =
        sub.status === 'frozen' ? { frozen_days_remaining: Math.max(0, daysBetween(today, expiresAt)) } : {};

      await subscriptionModel.update(
        sub.id,
        { plan_id: planId, starts_at: startsAt, expires_at: expiresAt, ...frozenPatch },
        trx,
      );
    }

    await recomputeMemberStatus(input.memberId, settings, trx);

    await auditLogModel.log(
      {
        gym_id: input.gymId,
        user_id: input.userId,
        action: 'member.updated',
        entity: 'member',
        entity_id: input.memberId,
        // the log carries what actually changed, so a disputed expiry date can
        // be traced back to who moved it and what it was before
        meta: {
          before: {
            full_name: member.full_name,
            phone: member.phone,
            sex: member.sex,
            joined_at: dateOnlyUtc(member.joined_at),
          },
          after: { ...input.member, ...(input.joinedAt ? { joined_at: input.joinedAt } : {}) },
          subscription: input.subscription ?? null,
        },
      },
      trx,
    );
  });

  // an expiry that just moved must not be judged against a cached door decision
  clearDebounce(input.gymId, input.memberId);
  return (await memberModel.findById(input.gymId, input.memberId)) as MemberRow;
}
