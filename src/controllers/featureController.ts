import type { Request, Response } from 'express';
import * as featureNoticeModel from '../models/featureNoticeModel';
import * as gymModel from '../models/gymModel';
import { badRequest, notFound } from '../utils/errors';

/**
 * What the platform currently allows this gym to use, and anything it has not
 * been told about yet.
 *
 * One request answers both questions on purpose: the app needs the live
 * entitlements to lock its controls AND the pending notices to raise the
 * alert, and splitting them would make the two disagree for a render.
 */
export async function state(req: Request, res: Response): Promise<void> {
  const [gym, pending, recent] = await Promise.all([
    gymModel.findById(req.auth.gymId),
    featureNoticeModel.listPending(req.auth.gymId),
    featureNoticeModel.listRecent(req.auth.gymId, 20),
  ]);
  if (!gym) throw notFound('Gym not found');

  res.json({
    camera_allowed: gym.camera_allowed,
    telegram_allowed: gym.telegram_allowed,
    pending,
    recent,
  });
}

/**
 * Dismiss a notice. Acknowledging is per-gym rather than per-user — see the
 * migration — so any signed-in member of staff can clear it, exactly like the
 * freeze alert they can already dismiss by logging out.
 */
export async function acknowledge(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Invalid notice id');
  const ok = await featureNoticeModel.acknowledge(req.auth.gymId, id, req.auth.sub);
  // Already seen (a second tab, a double tap) is a success, not a 404: the
  // caller wanted it gone and it is gone.
  res.json({ ok, pending: await featureNoticeModel.listPending(req.auth.gymId) });
}

export async function acknowledgeAll(req: Request, res: Response): Promise<void> {
  const count = await featureNoticeModel.acknowledgeAll(req.auth.gymId, req.auth.sub);
  res.json({ ok: true, acknowledged: count, pending: [] });
}
