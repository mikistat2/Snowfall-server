import crypto from 'crypto';
import type { Request, Response } from 'express';
import { env } from '../config/env';
import { signPlatformToken } from '../utils/jwt';
import { forbidden, notFound, unauthorized, AppError } from '../utils/errors';
import * as platformModel from '../models/platformModel';
import * as gymModel from '../models/gymModel';
import * as platformAlert from '../services/platformAlertService';

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as { email: string; password: string };
  if (!env.platformAdmin.password) {
    throw new AppError(503, 'Platform admin is not configured (set PLATFORM_ADMIN_PASSWORD)');
  }
  if (!safeEqual(email.toLowerCase(), env.platformAdmin.email.toLowerCase()) || !safeEqual(password, env.platformAdmin.password)) {
    throw unauthorized('Invalid email or password');
  }
  res.json({ token: signPlatformToken(), email: env.platformAdmin.email });
}

export async function overview(_req: Request, res: Response): Promise<void> {
  res.json(await platformModel.overview());
}

export async function listGyms(req: Request, res: Response): Promise<void> {
  res.json(await platformModel.listGyms(req.query.search as string | undefined));
}

export async function gymDetail(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  const [gyms, staff] = await Promise.all([platformModel.listGyms(), platformModel.gymStaff(id)]);
  const gym = gyms.find((g) => g.id === id);
  if (!gym) throw notFound('Gym not found');
  res.json({ ...gym, staff });
}

export async function freezeGym(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  const gym = await gymModel.findById(id);
  if (!gym) throw notFound('Gym not found');
  const note = (req.body as { note?: string }).note;
  await platformModel.setStatus(id, 'frozen', note ?? undefined);
  // kill active sessions so the freeze takes effect immediately
  await platformModel.revokeGymSessions(id);
  // tell the owner what happened and why (Telegram + email, best effort)
  const notified = await platformAlert.notifyGymOwners(id, gym.name, 'freeze', note);
  res.json({ ok: true, notified });
}

export async function unfreezeGym(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  const gym = await gymModel.findById(id);
  if (!gym) throw notFound('Gym not found');
  await platformModel.setStatus(id, 'active');
  const notified = await platformAlert.notifyGymOwners(id, gym.name, 'unfreeze');
  res.json({ ok: true, notified });
}

export async function getSettings(_req: Request, res: Response): Promise<void> {
  res.json(await platformModel.getSettings());
}

export async function updateSettings(req: Request, res: Response): Promise<void> {
  res.json(await platformModel.updateSettings(req.body));
}

/** Approve a pending registration: activate + start the paid year. */
export async function approveGym(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  const gym = await gymModel.findById(id);
  if (!gym) throw notFound('Gym not found');
  if (gym.status !== 'pending') throw forbidden('Only pending registrations can be approved');
  const ends = await platformModel.approveGym(id);
  const notified = await platformAlert.notifyGymOwners(id, gym.name, 'approve', ends.toDateString());
  res.json({ ok: true, subscription_ends_at: ends, notified });
}

/** Extend the yearly subscription by one year (also converts a trial to paid). */
export async function renewGym(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  const gym = await gymModel.findById(id);
  if (!gym) throw notFound('Gym not found');
  if (gym.status === 'pending') throw forbidden('Approve the registration first');
  const ends = await platformModel.renewGym(id);
  const notified = await platformAlert.notifyGymOwners(id, gym.name, 'renew', new Date(ends).toDateString());
  res.json({ ok: true, subscription_ends_at: ends, notified });
}

export async function updateNote(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  const gym = await gymModel.findById(id);
  if (!gym) throw notFound('Gym not found');
  await platformModel.setNote(id, (req.body as { note: string | null }).note);
  res.json({ ok: true });
}

export async function deleteGym(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  const gym = await gymModel.findById(id);
  if (!gym) throw notFound('Gym not found');
  const { confirm_name, note } = req.body as { confirm_name?: string; note?: string };
  if (confirm_name !== gym.name) {
    throw forbidden('Confirmation name does not match the gym name');
  }
  // alert BEFORE deleting — afterwards the owner accounts are gone
  const notified = await platformAlert.notifyGymOwners(id, gym.name, 'delete', note);
  await platformModel.deleteGym(id);
  res.json({ ok: true, notified });
}
