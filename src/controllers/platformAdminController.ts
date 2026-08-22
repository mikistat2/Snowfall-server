import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import type { Request, Response } from 'express';
import { env } from '../config/env';
import { signPlatformToken } from '../utils/jwt';
import { conflict, forbidden, notFound, unauthorized, AppError } from '../utils/errors';
import * as platformModel from '../models/platformModel';
import * as platformAdminModel from '../models/platformAdminModel';
import * as gymModel from '../models/gymModel';
import * as memberModel from '../models/memberModel';
import * as platformAlert from '../services/platformAlertService';
import * as auditLogModel from '../models/auditLogModel';
import * as botManager from '../telegram/botManager';
import type { BillingCycle, GymFeatures } from '../types';

/**
 * Owner alerts (Telegram/email) must never make the admin UI hang: wait at
 * most `ms`, then respond anyway — the alert keeps sending in the background.
 */
async function timeboxed<T>(promise: Promise<T>, ms = 4000): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms).unref?.()),
  ]);
}

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
  // the product owner (env credentials) — full access
  if (safeEqual(email.toLowerCase(), env.platformAdmin.email.toLowerCase()) && safeEqual(password, env.platformAdmin.password)) {
    res.json({
      token: signPlatformToken(),
      email: env.platformAdmin.email,
      role: 'owner',
      name: 'Platform Owner',
      permissions: { approve: true, freeze: true, renew: true, export: true },
    });
    return;
  }
  // sub-admins created by the owner — limited access
  const admin = await platformAdminModel.findByEmail(email);
  if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
    throw unauthorized('Invalid email or password');
  }
  const pub = platformAdminModel.toPublic(admin);
  res.json({
    token: signPlatformToken(admin.id, admin.name),
    email: admin.email,
    role: 'admin',
    name: admin.name,
    permissions: pub.permissions,
  });
}

/** Current session: role + live permissions (the UI re-syncs from this). */
export async function me(req: Request, res: Response): Promise<void> {
  const p = req.platform!;
  res.json({
    role: p.isOwner ? 'owner' : 'admin',
    name: p.name,
    permissions: p.permissions,
  });
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
  const notified = await timeboxed(platformAlert.notifyGymOwners(id, gym.name, 'freeze', note));
  res.json({ ok: true, notified });
}

export async function unfreezeGym(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  const gym = await gymModel.findById(id);
  if (!gym) throw notFound('Gym not found');
  await platformModel.setStatus(id, 'active');
  const notified = await timeboxed(platformAlert.notifyGymOwners(id, gym.name, 'unfreeze'));
  res.json({ ok: true, notified });
}

/**
 * Grant or revoke a gym's platform features (owner-only).
 *
 * Revoking is a lock, never a delete: enrolled face descriptors and the stored
 * bot token both survive, so restoring the entitlement brings the gym back
 * exactly as it was. Freeing that storage is a separate, deliberate act.
 *
 * Revoking Telegram stops the running bot in the same request rather than
 * waiting for the next boot — otherwise a revoked gym keeps sending messages
 * until the server restarts.
 */
export async function setFeatures(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  const gym = await gymModel.findById(id);
  if (!gym) throw notFound('Gym not found');

  const body = req.body as Partial<GymFeatures>;
  const updated = await gymModel.setFeatures(id, body);

  if (body.telegram_allowed === false && gym.telegram_allowed) {
    await botManager.stopBot(id);
  } else if (body.telegram_allowed === true && !gym.telegram_allowed && updated.telegram_bot_token) {
    await botManager.restartBot(id, updated.telegram_bot_token);
  }

  // Revoking the camera can strand staff on the monitor page with a live token
  // and a now-403 recognition loop; the audit trail is what explains it.
  await auditLogModel.log({
    gym_id: id,
    user_id: null,
    action: 'platform.features_updated',
    entity: 'gym',
    entity_id: id,
    meta: {
      camera_allowed: updated.camera_allowed,
      telegram_allowed: updated.telegram_allowed,
      by: req.platform?.isOwner ? 'platform_owner' : 'platform_admin',
    },
  });

  res.json({
    ok: true,
    camera_allowed: updated.camera_allowed,
    telegram_allowed: updated.telegram_allowed,
  });
}

/** Full member dump of ONE gym — the client renders it as that gym's members PDF. */
export async function exportGymMembers(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  const gym = await gymModel.findById(id);
  if (!gym) throw notFound('Gym not found');
  res.json({ gym_name: gym.name, members: await memberModel.exportByGym(id) });
}

/** Full member dump of every registered gym — the client renders it as a backup PDF. */
export async function exportAllMembers(_req: Request, res: Response): Promise<void> {
  const gyms = await platformModel.listGyms();
  const result = [];
  for (const gym of gyms) {
    result.push({ gym, members: await memberModel.exportByGym(gym.id) });
  }
  res.json(result);
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
  const notified = await timeboxed(platformAlert.notifyGymOwners(id, gym.name, 'approve', ends.toDateString()));
  res.json({ ok: true, subscription_ends_at: ends, notified });
}

/**
 * Extend the subscription by one month or one year (also converts a trial to
 * paid). No payment row is written here — this is the goodwill/free path. To
 * convert a trial AND keep a record of the money, use
 * POST /gyms/:id/record-payment instead.
 *
 * A trial conversion defaults to starting today: the days left on a free trial
 * are not something the gym paid for, so they are not carried into the paid
 * period unless the caller explicitly asks.
 */
export async function renewGym(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  const gym = await gymModel.findById(id);
  if (!gym) throw notFound('Gym not found');
  if (gym.status === 'pending') throw forbidden('Approve the registration first');
  const { cycle = 'YEARLY', fromNow } = req.body as { cycle?: BillingCycle; fromNow?: boolean };
  const ends = await platformModel.renewGym(id, cycle, fromNow ?? gym.is_trial);
  const notified = await timeboxed(
    platformAlert.notifyGymOwners(id, gym.name, 'renew', new Date(ends).toDateString()),
  );
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
  const notified = await timeboxed(platformAlert.notifyGymOwners(id, gym.name, 'delete', note), 8000);
  await platformModel.deleteGym(id);
  res.json({ ok: true, notified });
}

// ------------------------------------------- sub-admin management (owner) ----

export async function listAdmins(_req: Request, res: Response): Promise<void> {
  res.json(await platformAdminModel.list());
}

export async function createAdmin(req: Request, res: Response): Promise<void> {
  const { name, email, password, permissions } = req.body as {
    name: string;
    email: string;
    password: string;
    permissions: platformAdminModel.PlatformAdminPerms;
  };
  if (email.toLowerCase() === env.platformAdmin.email.toLowerCase()) {
    throw conflict('That email is the platform owner account');
  }
  if (await platformAdminModel.findByEmail(email)) {
    throw conflict('An admin with that email already exists');
  }
  const admin = await platformAdminModel.create({
    name,
    email,
    passwordHash: await bcrypt.hash(password, 10),
    permissions,
  });
  res.status(201).json(admin);
}

export async function updateAdmin(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  const { name, password, permissions } = req.body as {
    name?: string;
    password?: string;
    permissions?: Partial<platformAdminModel.PlatformAdminPerms>;
  };
  const admin = await platformAdminModel.update(id, {
    name,
    passwordHash: password ? await bcrypt.hash(password, 10) : undefined,
    permissions,
  });
  if (!admin) throw notFound('Admin not found');
  res.json(admin);
}

export async function removeAdmin(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  if (!(await platformAdminModel.remove(id))) throw notFound('Admin not found');
  // their token dies on the next request — requirePlatformAdmin re-checks the DB
  res.json({ ok: true });
}
