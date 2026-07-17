import bcrypt from 'bcryptjs';
import { db } from '../db/knex';
import * as gymModel from '../models/gymModel';
import * as userModel from '../models/userModel';
import * as refreshTokenModel from '../models/refreshTokenModel';
import * as platformModel from '../models/platformModel';
import * as platformAlert from './platformAlertService';
import {
  signAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  type AccessPayload,
} from '../utils/jwt';
import { conflict, forbidden, unauthorized } from '../utils/errors';

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: { id: number; name: string; email: string; role: 'owner' | 'staff'; gym_id: number };
  gym: { id: number; name: string };
}

/** Registration awaiting platform-admin approval — no tokens issued. */
export interface PendingRegistration {
  pending: true;
  gym: { id: number; name: string };
}

export async function registerGym(input: {
  gym: { name: string; address?: string; phone?: string };
  owner: { name: string; email: string; password: string; phone?: string };
}): Promise<AuthResult | PendingRegistration> {
  const existing = await userModel.findByEmail(input.owner.email);
  if (existing) throw conflict('An account with this email already exists');

  const passwordHash = await bcrypt.hash(input.owner.password, 10);

  // Free-trial mode (set by the platform admin): the gym starts immediately
  // on a limited trial. Otherwise it waits as 'pending' until approved.
  const platform = await platformModel.getSettings();
  const trialFields = platform.trial_mode
    ? {
        status: 'active' as const,
        is_trial: true,
        approved_at: new Date(),
        subscription_ends_at: new Date(Date.now() + platform.trial_days * 86_400_000),
      }
    : { status: 'pending' as const };

  const { gym, user } = await db.transaction(async (trx) => {
    const gym = await gymModel.create({ ...input.gym, ...trialFields }, trx);
    const user = await userModel.create(
      {
        gym_id: gym.id,
        name: input.owner.name,
        email: input.owner.email,
        phone: input.owner.phone ?? null,
        password_hash: passwordHash,
        role: 'owner',
      },
      trx,
    );
    return { gym, user };
  });

  // tell the platform admin (best effort, never blocks registration)
  void platformAlert
    .notifyPlatformAdmin(
      platform.trial_mode
        ? `New gym on FREE TRIAL: ${gym.name}`
        : `New gym awaiting approval: ${gym.name}`,
      `Gym: ${gym.name}\nOwner: ${user.name} <${user.email}>\nPhone: ${input.gym.phone ?? input.owner.phone ?? '-'}\n\n` +
        (platform.trial_mode
          ? `Registered on a ${platform.trial_days}-day free trial (trial mode is ON). No action needed.`
          : `Open your platform panel to approve or reject this registration.`),
    )
    .catch(() => undefined);

  if (gym.status === 'pending') {
    return { pending: true, gym: { id: gym.id, name: gym.name } };
  }

  return issueTokens({ sub: user.id, gymId: gym.id, role: 'owner', name: user.name }, {
    user: { id: user.id, name: user.name, email: user.email, role: user.role, gym_id: gym.id },
    gym: { id: gym.id, name: gym.name },
  });
}

export async function login(email: string, password: string): Promise<AuthResult> {
  const user = await userModel.findByEmail(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw unauthorized('Invalid email or password');
  }
  const gym = await gymModel.findById(user.gym_id);
  if (!gym) throw unauthorized('Gym not found');
  if (gym.status === 'frozen') {
    throw forbidden('This gym account has been frozen by the platform. Please contact support.', 'GYM_FROZEN');
  }
  if (gym.status === 'pending') {
    throw forbidden(
      'Your registration is still awaiting approval by the platform admin. You will be notified by email once it is approved.',
      'GYM_PENDING',
    );
  }

  return issueTokens({ sub: user.id, gymId: gym.id, role: user.role, name: user.name }, {
    user: { id: user.id, name: user.name, email: user.email, role: user.role, gym_id: gym.id },
    gym: { id: gym.id, name: gym.name },
  });
}

/** Rotate: verify + revoke the old refresh token, issue a fresh pair. */
export async function refresh(refreshToken: string): Promise<AuthResult> {
  const hash = hashRefreshToken(refreshToken);
  const stored = await refreshTokenModel.findValid(hash);
  if (!stored) throw unauthorized('Invalid refresh token');

  const user = await userModel.findById(stored.user_id);
  if (!user) throw unauthorized('User no longer exists');
  const gym = await gymModel.findById(user.gym_id);
  if (!gym) throw unauthorized('Gym not found');
  if (gym.status === 'frozen') {
    throw forbidden('This gym account has been frozen by the platform. Please contact support.', 'GYM_FROZEN');
  }
  if (gym.status === 'pending') {
    throw forbidden(
      'Your registration is still awaiting approval by the platform admin. You will be notified by email once it is approved.',
      'GYM_PENDING',
    );
  }

  await refreshTokenModel.revoke(hash);
  return issueTokens({ sub: user.id, gymId: gym.id, role: user.role, name: user.name }, {
    user: { id: user.id, name: user.name, email: user.email, role: user.role, gym_id: gym.id },
    gym: { id: gym.id, name: gym.name },
  });
}

export async function logout(refreshToken: string): Promise<void> {
  await refreshTokenModel.revoke(hashRefreshToken(refreshToken));
}

async function issueTokens(
  payload: AccessPayload,
  identity: Pick<AuthResult, 'user' | 'gym'>,
): Promise<AuthResult> {
  const accessToken = signAccessToken(payload);
  const { token, hash, expiresAt } = generateRefreshToken();
  await refreshTokenModel.create(payload.sub, hash, expiresAt);
  return { accessToken, refreshToken: token, ...identity };
}
