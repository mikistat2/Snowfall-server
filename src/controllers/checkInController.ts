import type { Request, Response } from 'express';
import * as checkInService from '../services/checkInService';
import * as checkInModel from '../models/checkInModel';
import * as eventModel from '../models/eventModel';
import * as occupancyService from '../services/occupancyService';

export async function recognize(req: Request, res: Response): Promise<void> {
  res.json(
    await checkInService.recognize({
      gymId: req.auth.gymId,
      memberId: req.body.member_id,
      guestId: req.body.guest_id,
      descriptor: req.body.descriptor,
      confidence: req.body.confidence,
    }),
  );
}

export async function override(req: Request, res: Response): Promise<void> {
  res.json(await checkInService.override(req.auth.gymId, req.body.member_id, req.auth.sub));
}

export async function approve(req: Request, res: Response): Promise<void> {
  res.json(await checkInService.approve(req.auth.gymId, req.body.member_id, req.auth.sub));
}

export async function checkout(req: Request, res: Response): Promise<void> {
  await checkInService.checkout(req.auth.gymId, Number(req.params.id));
  res.json({ checked_out: true });
}

export async function listOpen(req: Request, res: Response): Promise<void> {
  res.json(await checkInModel.listOpen(req.auth.gymId));
}

export async function occupancy(req: Request, res: Response): Promise<void> {
  res.json({ count: await occupancyService.getOccupancy(req.auth.gymId) });
}

export async function recentEvents(req: Request, res: Response): Promise<void> {
  res.json(await eventModel.listRecent(req.auth.gymId, Number(req.query.limit ?? 50)));
}
