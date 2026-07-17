import type { Request, Response } from 'express';
import * as memberModel from '../models/memberModel';
import * as memberService from '../services/memberService';
import * as paymentService from '../services/paymentService';
import * as auditLogModel from '../models/auditLogModel';
import { notFound } from '../utils/errors';
import type { MemberStatus } from '../types';

export async function list(req: Request, res: Response): Promise<void> {
  res.json(
    await memberModel.listByGym(req.auth.gymId, {
      search: req.query.search as string | undefined,
      status: req.query.status as MemberStatus | undefined,
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

export async function enroll(req: Request, res: Response): Promise<void> {
  const member = await memberService.enroll({
    gymId: req.auth.gymId,
    userId: req.auth.sub,
    member: req.body.member,
    descriptors: req.body.descriptors ?? [],
    planId: req.body.plan_id,
    payment: req.body.payment,
  });
  res.status(201).json(member);
}

export async function update(req: Request, res: Response): Promise<void> {
  const member = await memberModel.update(req.auth.gymId, Number(req.params.id), req.body);
  if (!member) throw notFound('Member not found');
  await auditLogModel.log({
    gym_id: req.auth.gymId,
    user_id: req.auth.sub,
    action: 'member.updated',
    entity: 'member',
    entity_id: member.id,
  });
  res.json(member);
}

/** All descriptors for the gym — the monitor page's recognition cache. */
export async function allDescriptors(req: Request, res: Response): Promise<void> {
  res.json(await memberModel.listDescriptorsByGym(req.auth.gymId));
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

export async function freeze(req: Request, res: Response): Promise<void> {
  await memberService.freeze(req.auth.gymId, Number(req.params.id), req.auth.sub);
  res.json({ frozen: true });
}

export async function unfreeze(req: Request, res: Response): Promise<void> {
  await memberService.unfreeze(req.auth.gymId, Number(req.params.id), req.auth.sub);
  res.json({ frozen: false });
}
