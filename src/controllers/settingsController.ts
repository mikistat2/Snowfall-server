import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import * as gymModel from '../models/gymModel';
import * as userModel from '../models/userModel';
import * as auditLogModel from '../models/auditLogModel';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors';
import { DEFAULT_SETTINGS } from '../types';

export async function getGym(req: Request, res: Response): Promise<void> {
  const gym = await gymModel.findById(req.auth.gymId);
  if (!gym) throw notFound('Gym not found');
  // getSettings, not a raw spread: it narrows camera_enabled by the platform
  // entitlement, so the monitor and the settings screen see the same effective
  // value the rest of the server enforces. `camera_allowed`/`telegram_allowed`
  // ride along on the row so the UI can say *why* a control is locked.
  res.json({ ...gym, settings: gymModel.getSettings(gym) });
}

export async function updateGym(req: Request, res: Response): Promise<void> {
  const { settings, ...info } = req.body;
  let gym = await gymModel.findById(req.auth.gymId);
  if (!gym) throw notFound('Gym not found');

  const tokenChanged =
    'telegram_bot_token' in info && info.telegram_bot_token !== gym.telegram_bot_token;
  // Connecting a bot is the one settings write that a revoked entitlement has
  // to refuse outright — everything else is a stored preference that
  // getSettings already neutralises on read.
  if (tokenChanged && info.telegram_bot_token && !gym.telegram_allowed) {
    throw forbidden(
      'Telegram notifications are not enabled for this gym. Contact the platform administrator.',
      'TELEGRAM_NOT_ALLOWED',
    );
  }

  if (Object.keys(info).length > 0) gym = await gymModel.update(req.auth.gymId, info);

  if (tokenChanged) {
    const { restartBot } = await import('../telegram/botManager');
    void restartBot(req.auth.gymId, gym.telegram_bot_token).catch(() => undefined);
  }
  if (settings) {
    gym = await gymModel.updateSettings(req.auth.gymId, { ...DEFAULT_SETTINGS, ...gym.settings, ...settings });
  }
  await auditLogModel.log({
    gym_id: req.auth.gymId,
    user_id: req.auth.sub,
    action: 'settings.updated',
    entity: 'gym',
    entity_id: req.auth.gymId,
  });
  res.json(gym);
}

export async function listStaff(req: Request, res: Response): Promise<void> {
  res.json(await userModel.listByGym(req.auth.gymId));
}

export async function createStaff(req: Request, res: Response): Promise<void> {
  const existing = await userModel.findByEmail(req.body.email);
  if (existing) throw conflict('An account with this email already exists');
  const user = await userModel.create({
    gym_id: req.auth.gymId,
    name: req.body.name,
    phone: req.body.phone ?? null,
    email: req.body.email,
    password_hash: await bcrypt.hash(req.body.password, 10),
    role: 'staff',
  });
  await auditLogModel.log({
    gym_id: req.auth.gymId,
    user_id: req.auth.sub,
    action: 'staff.created',
    entity: 'user',
    entity_id: user.id,
  });
  res.status(201).json({ id: user.id, name: user.name, email: user.email, role: user.role });
}

export async function removeStaff(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  if (id === req.auth.sub) throw badRequest('You cannot delete your own account');
  const target = await userModel.findById(id);
  if (!target || target.gym_id !== req.auth.gymId) throw notFound('User not found');
  if (target.role === 'owner') throw badRequest('Owner accounts cannot be deleted');
  await userModel.remove(req.auth.gymId, id);
  await auditLogModel.log({
    gym_id: req.auth.gymId,
    user_id: req.auth.sub,
    action: 'staff.removed',
    entity: 'user',
    entity_id: id,
  });
  res.status(204).end();
}
