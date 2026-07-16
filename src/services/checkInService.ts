import { db } from '../db/knex';
import * as gymModel from '../models/gymModel';
import * as memberModel from '../models/memberModel';
import * as subscriptionModel from '../models/subscriptionModel';
import * as checkInModel from '../models/checkInModel';
import * as eventModel from '../models/eventModel';
import * as auditLogModel from '../models/auditLogModel';
import * as guestModel from '../models/guestModel';
import * as occupancyService from './occupancyService';
import { decideCheckIn, decideGuestPass, euclideanDistance, type Decision } from './decisionEngine';
import { emitToGym } from '../sockets';
import { badRequest, notFound } from '../utils/errors';
import type { MemberRow, Severity } from '../types';

/**
 * Debounce: ignore repeat recognitions of the same person within 5 minutes.
 * Key is `gym:member`; survives across sockets/clients because it lives here.
 */
const DEBOUNCE_MS = 5 * 60 * 1000;
const lastSeen = new Map<string, { at: number; result: RecognizeResult }>();

export interface RecognizeResult {
  matched: boolean;
  debounced?: boolean;
  /** Manual entry mode: allowed but waiting for staff approval (no rows yet). */
  pending?: boolean;
  member?: { id: number; full_name: string; status: string };
  guest?: { id: number; name: string };
  decision?: Decision;
  checkInId?: number;
}

export async function recognize(input: {
  gymId: number;
  memberId?: number;
  guestId?: number;
  descriptor?: number[];
  confidence?: number;
}): Promise<RecognizeResult> {
  const gym = await gymModel.findById(input.gymId);
  if (!gym) throw notFound('Gym not found');
  const settings = gymModel.getSettings(gym);

  // --- resolve person (client-side match sends member_id/guest_id; descriptor is the fallback) ---
  let member: MemberRow | undefined;
  let guestId = input.guestId;
  let confidence = input.confidence ?? null;

  if (input.memberId) {
    member = await memberModel.findById(input.gymId, input.memberId);
    if (!member) throw notFound('Member not found');
  } else if (!guestId && input.descriptor) {
    const match = await matchDescriptor(input.gymId, input.descriptor, settings.match_threshold);
    if (match?.memberId) {
      member = await memberModel.findById(input.gymId, match.memberId);
      confidence = match.distance;
    } else if (match?.guestId) {
      guestId = match.guestId;
      confidence = match.distance;
    }
  } else if (!guestId) {
    throw badRequest('member_id, guest_id or descriptor required');
  }

  if (!member && guestId) {
    return recognizeGuest(input.gymId, guestId, confidence);
  }

  if (!member) {
    const event = await eventModel.create({
      gym_id: input.gymId,
      type: 'unknown_face',
      severity: 'red',
      message: 'unknown · no match',
    });
    emitToGym(input.gymId, 'event:new', event);
    // owner alert when an unknown face shows up 3+ times in a day (Phase 2)
    void import('../services/notificationService').then((s) =>
      s.maybeAlertUnknownFace(input.gymId).catch(() => undefined),
    );
    return { matched: false };
  }

  if (!member) {
    // unreachable (member/guest paths both handled above), but keeps TS happy
    return { matched: false };
  }

  // --- debounce repeat recognitions ---
  const key = `${input.gymId}:m${member.id}`;
  const seen = lastSeen.get(key);
  if (seen && Date.now() - seen.at < DEBOUNCE_MS) {
    return { ...seen.result, debounced: true };
  }

  // --- decide ---
  const now = new Date();
  const sub = await subscriptionModel.findCurrentWithPlan(member.id);
  const firstToday = await checkInModel.findAllowedToday(member.id, now);

  const decision = decideCheckIn({
    frozen: sub?.status === 'frozen',
    expiresAt: sub?.expires_at ?? null,
    sessionsPerDay: sub?.sessions_per_day ?? null,
    allowedHours: sub?.allowed_hours ?? null,
    firstAllowedToday: firstToday?.checked_in_at ?? null,
    now,
    settings,
  });

  // keep stored status in sync with derived reality (on-the-fly recompute)
  if (member.status !== decision.derivedStatus) {
    await memberModel.setStatus(member.id, decision.derivedStatus);
    member.status = decision.derivedStatus;
  }

  // manual entry mode: allowed members wait for a staff click; nothing is
  // recorded until approval (denials still record + broadcast as usual)
  if (decision.allowed && settings.entry_mode === 'manual') {
    const event = await eventModel.create({
      gym_id: input.gymId,
      type: 'entry_pending',
      severity: 'yellow',
      message: `${member.full_name} — awaiting approval · ${decision.message}`,
      member_id: member.id,
    });
    const result: RecognizeResult = {
      matched: true,
      pending: true,
      member: { id: member.id, full_name: member.full_name, status: member.status },
      decision,
    };
    lastSeen.set(key, { at: Date.now(), result });
    emitToGym(input.gymId, 'checkin:result', result);
    emitToGym(input.gymId, 'event:new', event);
    return result;
  }

  // --- persist decision + event ---
  const checkIn = await checkInModel.create({
    gym_id: input.gymId,
    member_id: member.id,
    decision: decision.code,
    confidence,
  });

  const event = await eventModel.create({
    gym_id: input.gymId,
    type: decision.allowed ? 'check_in' : 'check_in_denied',
    severity: decision.severity,
    message: `${member.full_name} — ${decision.message}`,
    member_id: member.id,
  });

  const result: RecognizeResult = {
    matched: true,
    member: { id: member.id, full_name: member.full_name, status: member.status },
    decision,
    checkInId: checkIn.id,
  };
  lastSeen.set(key, { at: Date.now(), result });

  // --- broadcast ---
  emitToGym(input.gymId, 'checkin:result', result);
  emitToGym(input.gymId, 'event:new', event);
  if (decision.allowed) await occupancyService.adjust(input.gymId, +1);

  return result;
}

/**
 * Manual entry mode: staff approves a pending (allowed) entry. Re-runs the
 * decision so a member who stopped qualifying meanwhile is denied, records
 * the check-in with the real decision code, and is idempotent like override.
 */
export async function approve(gymId: number, memberId: number, userId: number): Promise<RecognizeResult> {
  const gym = await gymModel.findById(gymId);
  if (!gym) throw notFound('Gym not found');
  const settings = gymModel.getSettings(gym);
  const member = await memberModel.findById(gymId, memberId);
  if (!member) throw notFound('Member not found');

  const open = await checkInModel.findOpenByMember(memberId);
  if (open) {
    return {
      matched: true,
      member: { id: member.id, full_name: member.full_name, status: member.status },
      checkInId: open.id,
    };
  }

  const now = new Date();
  const sub = await subscriptionModel.findCurrentWithPlan(member.id);
  const firstToday = await checkInModel.findAllowedToday(member.id, now);
  const decision = decideCheckIn({
    frozen: sub?.status === 'frozen',
    expiresAt: sub?.expires_at ?? null,
    sessionsPerDay: sub?.sessions_per_day ?? null,
    allowedHours: sub?.allowed_hours ?? null,
    firstAllowedToday: firstToday?.checked_in_at ?? null,
    now,
    settings,
  });

  const checkIn = await checkInModel.create({
    gym_id: gymId,
    member_id: member.id,
    decision: decision.code,
  });
  const event = await eventModel.create({
    gym_id: gymId,
    type: decision.allowed ? 'check_in' : 'check_in_denied',
    severity: decision.severity,
    message: decision.allowed
      ? `${member.full_name} — ${decision.message} · approved by staff`
      : `${member.full_name} — ${decision.message}`,
    member_id: member.id,
  });
  await auditLogModel.log({
    gym_id: gymId,
    user_id: userId,
    action: 'checkin.approved',
    entity: 'member',
    entity_id: memberId,
  });

  const result: RecognizeResult = {
    matched: true,
    member: { id: member.id, full_name: member.full_name, status: member.status },
    decision,
    checkInId: checkIn.id,
  };
  lastSeen.set(`${gymId}:m${memberId}`, { at: Date.now(), result });

  emitToGym(gymId, 'checkin:result', result);
  emitToGym(gymId, 'event:new', event);
  if (decision.allowed) await occupancyService.adjust(gymId, +1);

  return result;
}

/**
 * Staff override on a denied entry: record an 'override' check-in and let
 * them in. Idempotent — repeat clicks while the member is already inside
 * return the existing session instead of stacking new ones.
 */
export async function override(gymId: number, memberId: number, userId: number): Promise<RecognizeResult> {
  const member = await memberModel.findById(gymId, memberId);
  if (!member) throw notFound('Member not found');

  const open = await checkInModel.findOpenByMember(memberId);
  if (open) {
    return {
      matched: true,
      member: { id: member.id, full_name: member.full_name, status: member.status },
      checkInId: open.id,
    };
  }

  const checkIn = await checkInModel.create({ gym_id: gymId, member_id: memberId, decision: 'override' });
  const event = await eventModel.create({
    gym_id: gymId,
    type: 'override',
    severity: 'green',
    message: `${member.full_name} — entry allowed by staff override`,
    member_id: memberId,
  });
  await auditLogModel.log({
    gym_id: gymId,
    user_id: userId,
    action: 'checkin.override',
    entity: 'member',
    entity_id: memberId,
  });

  emitToGym(gymId, 'event:new', event);
  await occupancyService.adjust(gymId, +1);

  // reset debounce so the camera doesn't immediately re-deny them
  lastSeen.set(`${gymId}:m${memberId}`, {
    at: Date.now(),
    result: { matched: true, member: { id: member.id, full_name: member.full_name, status: member.status } },
  });

  return { matched: true, member: { id: member.id, full_name: member.full_name, status: member.status }, checkInId: checkIn.id };
}

export async function checkout(gymId: number, checkInId: number, method: 'manual' | 'camera' = 'manual'): Promise<void> {
  const existing = await checkInModel.findById(gymId, checkInId);
  if (!existing) throw notFound('Check-in not found');
  if (existing.checked_out_at) throw badRequest('Already checked out');

  const row = await checkInModel.checkout(checkInId, method);
  if (!row) return;

  let name = 'Guest';
  if (existing.member_id) {
    const member = await memberModel.findById(gymId, existing.member_id);
    name = member?.full_name ?? 'Member';
  }
  const event = await eventModel.create({
    gym_id: gymId,
    type: 'check_out',
    severity: 'blue',
    message: `${name} — checked out`,
    member_id: existing.member_id,
  });
  emitToGym(gymId, 'event:new', event);
  await occupancyService.adjust(gymId, -1);
}

/** Guest entry: valid pass → allow (BLUE); expired → deny. */
async function recognizeGuest(
  gymId: number,
  guestId: number,
  confidence: number | null,
): Promise<RecognizeResult> {
  const guest = await guestModel.findById(gymId, guestId);
  if (!guest) throw notFound('Guest not found');

  const key = `${gymId}:g${guest.id}`;
  const seen = lastSeen.get(key);
  if (seen && Date.now() - seen.at < DEBOUNCE_MS) {
    return { ...seen.result, debounced: true };
  }

  const decision = decideGuestPass(new Date(guest.valid_until), new Date());

  const checkIn = await checkInModel.create({
    gym_id: gymId,
    guest_id: guest.id,
    decision: decision.code,
    confidence,
  });
  const event = await eventModel.create({
    gym_id: gymId,
    type: decision.allowed ? 'guest_check_in' : 'check_in_denied',
    severity: decision.severity,
    message: `${guest.name} — ${decision.message}`,
  });

  const result: RecognizeResult = {
    matched: true,
    guest: { id: guest.id, name: guest.name },
    decision,
    checkInId: checkIn.id,
  };
  lastSeen.set(key, { at: Date.now(), result });

  emitToGym(gymId, 'checkin:result', result);
  emitToGym(gymId, 'event:new', event);
  if (decision.allowed) await occupancyService.adjust(gymId, +1);

  return result;
}

async function matchDescriptor(
  gymId: number,
  descriptor: number[],
  threshold: number,
): Promise<{ memberId?: number; guestId?: number; distance: number } | undefined> {
  const [entries, guests] = await Promise.all([
    memberModel.listDescriptorsByGym(gymId),
    guestModel.listActiveDescriptors(gymId),
  ]);
  let best: { memberId?: number; guestId?: number; distance: number } | undefined;
  for (const entry of entries) {
    for (const d of entry.descriptors) {
      const dist = euclideanDistance(descriptor, d);
      if (dist <= threshold && (!best || dist < best.distance)) {
        best = { memberId: entry.member_id, distance: dist };
      }
    }
  }
  for (const guest of guests) {
    const dist = euclideanDistance(descriptor, guest.descriptor);
    if (dist <= threshold && (!best || dist < best.distance)) {
      best = { guestId: guest.guest_id, distance: dist };
    }
  }
  return best;
}

/**
 * Drop the cached decision for a member so status changes (freeze, unfreeze,
 * renewal) take effect at the door immediately instead of after 5 minutes.
 */
export function clearDebounce(gymId: number, memberId: number): void {
  lastSeen.delete(`${gymId}:m${memberId}`);
}

/** Test hook: clear the debounce cache. */
export function _resetDebounce(): void {
  lastSeen.clear();
}
