import type { Request, Response } from 'express';
import * as memberModel from '../models/memberModel';
import * as memberService from '../services/memberService';
import * as paymentService from '../services/paymentService';
import { forbidden, notFound } from '../utils/errors';
import { parseLimit, parseOffset } from '../utils/pagination';
import type { MemberStatus } from '../types';

export async function list(req: Request, res: Response): Promise<void> {
  res.json(
    await memberModel.listByGym(req.auth.gymId, {
      search: req.query.search as string | undefined,
      status: req.query.status as MemberStatus | undefined,
      archived: req.query.archived === 'true',
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset),
    }),
  );
}

/** Full data dump for the client-side PDF export. */
export async function exportData(req: Request, res: Response): Promise<void> {
  res.json(await memberModel.exportByGym(req.auth.gymId));
}

export async function detail(req: Request, res: Response): Promise<void> {
  res.json(await memberService.detail(req.auth.gymId, Number(req.params.id)));
}

/**
 * Enrolment stays open with the camera revoked — a gym in name-board mode
 * still signs members up — but face captures sent alongside are dropped
 * rather than stored. The route is therefore not behind requireFeature; this
 * is the narrower rule it needs.
 */
function allowedDescriptors(req: Request): number[][] {
  if (!req.gym?.camera_allowed) return [];
  return req.body.descriptors ?? [];
}

export async function enroll(req: Request, res: Response): Promise<void> {
  const member = await memberService.enroll({
    gymId: req.auth.gymId,
    userId: req.auth.sub,
    member: req.body.member,
    descriptors: allowedDescriptors(req),
    planId: req.body.plan_id,
    payment: req.body.payment,
  });
  res.status(201).json(member);
}

/** Back-fill of a member from the gym's pre-installation paper register. */
export async function enrollPrevious(req: Request, res: Response): Promise<void> {
  const member = await memberService.enrollPrevious({
    gymId: req.auth.gymId,
    userId: req.auth.sub,
    member: req.body.member,
    descriptors: allowedDescriptors(req),
    planId: req.body.plan_id,
    calendar: req.body.calendar,
    enteredCalendar: req.body.entered_calendar,
    joinedAt: req.body.joined_at,
    startsAt: req.body.starts_at,
    expiresAt: req.body.expires_at,
    payment: req.body.payment,
  });
  res.status(201).json(member);
}

/**
 * Admin correction of a member.
 *
 * The body is a patch: only the keys that were sent are touched, so the modal
 * can post the contact fields alone and leave the dates exactly as they are.
 * `member.*` is flat at the top level for backwards compatibility with the
 * original name/phone-only endpoint; the dates arrive under their own keys.
 *
 * Everything is Gregorian by the time it gets here — the client's date field
 * converts as you type, the same way the previous-member form does.
 */
export async function update(req: Request, res: Response): Promise<void> {
  const { joined_at, subscription, ...member } = req.body as {
    full_name?: string;
    phone?: string | null;
    sex?: 'male' | 'female' | null;
    photo_url?: string | null;
    joined_at?: string;
    subscription?: { plan_id?: number; starts_at?: string; expires_at?: string };
  };

  // Moving an expiry date hands out gym time without a payment behind it, so it
  // sits with the other owner-only actions (archive, delete, the audit log).
  // Correcting a name or a phone number stays open to staff at the desk.
  if (subscription && req.auth.role !== 'owner') {
    throw forbidden('Only the owner can change a membership’s plan or dates');
  }

  const updated = await memberService.updateMember({
    gymId: req.auth.gymId,
    userId: req.auth.sub,
    memberId: Number(req.params.id),
    member: Object.keys(member).length > 0 ? member : undefined,
    joinedAt: joined_at,
    subscription: subscription
      ? {
          planId: subscription.plan_id,
          startsAt: subscription.starts_at,
          expiresAt: subscription.expires_at,
        }
      : undefined,
  });
  res.json(updated);
}

/** All descriptors for the gym — the monitor page's recognition cache. */
export async function allDescriptors(req: Request, res: Response): Promise<void> {
  res.json(await memberModel.listDescriptorsByGym(req.auth.gymId));
}

/**
 * Change-token for the above. The monitor polls this every 60s (~50 bytes)
 * and only re-downloads the megabyte-scale descriptor payload when it moves.
 */
export async function descriptorsVersion(req: Request, res: Response): Promise<void> {
  res.json({ version: await memberModel.descriptorsVersion(req.auth.gymId) });
}

export async function addDescriptors(req: Request, res: Response): Promise<void> {
  const memberId = Number(req.params.id);
  const member = await memberModel.findById(req.auth.gymId, memberId);
  if (!member) throw notFound('Member not found');
  if (req.body.replace) await memberModel.clearDescriptors(memberId);
  await memberModel.addDescriptors(memberId, req.body.descriptors);
  res.status(201).json({ count: await memberModel.descriptorCount(memberId) });
}

export async function renew(req: Request, res: Response): Promise<void> {
  res.json(
    await paymentService.renew({
      gymId: req.auth.gymId,
      memberId: Number(req.params.id),
      planId: req.body.plan_id,
      amount: req.body.amount,
      method: req.body.method,
      note: req.body.note,
      userId: req.auth.sub,
    }),
  );
}

/** Off the roster, money history intact. */
export async function archive(req: Request, res: Response): Promise<void> {
  res.json(await memberService.archive(req.auth.gymId, Number(req.params.id), req.auth.sub));
}

export async function restore(req: Request, res: Response): Promise<void> {
  res.json(await memberService.restore(req.auth.gymId, Number(req.params.id), req.auth.sub));
}

/** Permanent — refused (400) for anyone who has ever paid. */
export async function remove(req: Request, res: Response): Promise<void> {
  await memberService.remove(req.auth.gymId, Number(req.params.id), req.auth.sub);
  res.json({ deleted: true });
}

export async function freeze(req: Request, res: Response): Promise<void> {
  await memberService.freeze(req.auth.gymId, Number(req.params.id), req.auth.sub);
  res.json({ frozen: true });
}

export async function unfreeze(req: Request, res: Response): Promise<void> {
  await memberService.unfreeze(req.auth.gymId, Number(req.params.id), req.auth.sub);
  res.json({ frozen: false });
}
