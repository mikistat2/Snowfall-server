import type { Knex } from 'knex';
import { db } from '../db/knex';
import * as gymModel from '../models/gymModel';
import * as subscriptionModel from '../models/subscriptionModel';
import * as memberModel from '../models/memberModel';
import { deriveStatus } from './decisionEngine';
import { dateOnly, daysBetween } from '../utils/dates';
import type { GymSettings, MemberStatus } from '../types';

/** Recompute one member's status from their latest subscription. */
export async function recomputeMemberStatus(
  memberId: number,
  settings: GymSettings,
  trx: Knex = db,
): Promise<MemberStatus> {
  const sub = await subscriptionModel.findLatestByMember(memberId, trx);
  const frozen = sub?.status === 'frozen';
  const daysLeft = sub ? daysBetween(dateOnly(new Date()), sub.expires_at) : null;
  const status = deriveStatus(daysLeft, settings, frozen);

  await memberModel.setStatus(memberId, status, trx);
  if (sub && !frozen) {
    const subStatus = status === 'expired' ? 'expired' : 'active';
    if (sub.status !== subStatus) await subscriptionModel.update(sub.id, { status: subStatus }, trx);
  }
  return status;
}

/** Daily recompute for every member of a gym (00:05 cron + on demand). */
export async function recomputeGymStatuses(gymId: number): Promise<{ updated: number }> {
  const gym = await gymModel.findById(gymId);
  if (!gym) return { updated: 0 };
  const settings = gymModel.getSettings(gym);
  const today = dateOnly(new Date());

  const rows = await subscriptionModel.listLatestForGym(gymId);
  let updated = 0;

  for (const row of rows) {
    const frozen = row.sub_status === 'frozen';
    const status = deriveStatus(daysBetween(today, row.expires_at), settings, frozen);
    if (status !== row.member_status) {
      await memberModel.setStatus(row.member_id, status);
      updated++;
    }
    if (!frozen) {
      const subStatus = status === 'expired' ? 'expired' : 'active';
      if (row.sub_status !== subStatus) {
        await subscriptionModel.update(row.subscription_id, { status: subStatus });
      }
    }
  }
  return { updated };
}

export async function recomputeAllGyms(): Promise<void> {
  const gyms = await gymModel.listAll();
  for (const gym of gyms) {
    await recomputeGymStatuses(gym.id);
  }
}
