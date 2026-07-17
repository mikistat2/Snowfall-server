import bcrypt from 'bcryptjs';
import { db } from '../db/knex';
import * as gymModel from '../models/gymModel';
import * as userModel from '../models/userModel';
import * as refreshTokenModel from '../models/refreshTokenModel';
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

export async function registerGym(input: {
  gym: { name: string; address?: string; phone?: string };
  owner: { name: string; email: string; password: string; phone?: string };
}): Promise<AuthResult> {
  const existing = await userModel.findByEmail(input.owner.email);
  if (existing) throw conflict('An account with this email already exists');

  const passwordHash = await bcrypt.hash(input.owner.password, 10);

  const { gym, user } = await db.transaction(async (trx) => {
    const gym = await gymModel.create(input.gym, trx);
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
