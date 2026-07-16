import type { Request, Response } from 'express';
import * as guestModel from '../models/guestModel';
import * as memberModel from '../models/memberModel';
import * as eventModel from '../models/eventModel';
import * as auditLogModel from '../models/auditLogModel';
import { emitToGym } from '../sockets';
import { notFound } from '../utils/errors';
import { dateOnly } from '../utils/dates';

/** Day pass ends at 23:59:59 local; trials add N extra days. */
function passEnd(validDays: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + validDays);
  d.setHours(23, 59, 59, 999);
  return d;
}

export async function create(req: Request, res: Response): Promise<void> {
  const guest = await guestModel.create({
    gym_id: req.auth.gymId,
    name: req.body.name,
    descriptor: req.body.descriptor ?? null,
    valid_until: passEnd(req.body.valid_days ?? 0),
    created_by: req.auth.sub,
  });

  const event = await eventModel.create({
    gym_id: req.auth.gymId,
    type: 'guest_added',
    severity: 'blue',
    message: `${guest.name} — guest pass created · valid until ${dateOnly(new Date(guest.valid_until))}`,
  });
  emitToGym(req.auth.gymId, 'event:new', event);

  await auditLogModel.log({
    gym_id: req.auth.gymId,
    user_id: req.auth.sub,
    action: 'guest.created',
    entity: 'guest',
    entity_id: guest.id,
    meta: { valid_until: guest.valid_until },
  });
  res.status(201).json(guest);
}

export async function list(req: Request, res: Response): Promise<void> {
  res.json(await guestModel.listByGym(req.auth.gymId));
}

/** Active guest descriptors — merged into the monitor's recognition cache. */
export async function descriptors(req: Request, res: Response): Promise<void> {
  res.json(await guestModel.listActiveDescriptors(req.auth.gymId));
}

export async function expire(req: Request, res: Response): Promise<void> {
  const guest = await guestModel.expireNow(req.auth.gymId, Number(req.params.id));
  if (!guest) throw notFound('Guest not found');
  await auditLogModel.log({
    gym_id: req.auth.gymId,
    user_id: req.auth.sub,
    action: 'guest.expired',
    entity: 'guest',
    entity_id: guest.id,
  });
  res.json(guest);
}

/** Mark a guest as converted to an (already enrolled) member. */
export async function convert(req: Request, res: Response): Promise<void> {
  const guestId = Number(req.params.id);
  const guest = await guestModel.findById(req.auth.gymId, guestId);
  if (!guest) throw notFound('Guest not found');
  const member = await memberModel.findById(req.auth.gymId, req.body.member_id);
  if (!member) throw notFound('Member not found');

  await guestModel.setConvertedMember(req.auth.gymId, guestId, member.id);
  await auditLogModel.log({
    gym_id: req.auth.gymId,
    user_id: req.auth.sub,
    action: 'guest.converted',
    entity: 'guest',
    entity_id: guestId,
    meta: { member_id: member.id },
  });
  res.json({ converted: true, member_id: member.id });
}
