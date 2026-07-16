import { db } from '../db/knex';

export type NotificationType =
  | 'expiry_reminder'
  | 'expired'
  | 'absence_nudge'
  | 'receipt'
  | 'admin_alert'
  | 'admin_summary';
export type NotificationStatus = 'sent' | 'failed' | 'skipped_no_chat_id';

export interface NotificationRow {
  id: number;
  gym_id: number;
  member_id: number | null;
  type: NotificationType;
  channel: 'bot' | 'mtproto';
  status: NotificationStatus;
  payload: Record<string, unknown>;
  sent_at: Date;
}

export async function create(data: {
  gym_id: number;
  member_id?: number | null;
  type: NotificationType;
  status: NotificationStatus;
  payload?: Record<string, unknown>;
}): Promise<NotificationRow> {
  const [row] = await db('notifications')
    .insert({ ...data, channel: 'bot', payload: JSON.stringify(data.payload ?? {}) })
    .returning('*');
  return row;
}

export async function list(
  gymId: number,
  filter: { type?: NotificationType; status?: NotificationStatus } = {},
  limit = 200,
): Promise<(NotificationRow & { member_name: string | null })[]> {
  const q = db('notifications as n')
    .leftJoin('members as m', 'm.id', 'n.member_id')
    .where('n.gym_id', gymId)
    .select('n.*', 'm.full_name as member_name')
    .orderBy('n.sent_at', 'desc')
    .limit(limit);
  if (filter.type) q.andWhere('n.type', filter.type);
  if (filter.status) q.andWhere('n.status', filter.status);
  return q;
}

/** Most recent notification of a type for a member (dedupe windows). */
export async function lastForMember(
  memberId: number,
  type: NotificationType,
): Promise<NotificationRow | undefined> {
  return db('notifications')
    .where({ member_id: memberId, type })
    .whereIn('status', ['sent', 'failed', 'skipped_no_chat_id'])
    .orderBy('sent_at', 'desc')
    .first();
}

export async function countForMember(memberId: number, type: NotificationType): Promise<number> {
  const row = await db('notifications')
    .where({ member_id: memberId, type })
    .count<{ count: string }>('id as count')
    .first();
  return Number(row?.count ?? 0);
}

/** Has the gym already received this admin notification today? */
export async function sentToGymToday(
  gymId: number,
  type: NotificationType,
  now: Date,
): Promise<boolean> {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const row = await db('notifications')
    .where({ gym_id: gymId, type })
    .where('sent_at', '>=', startOfDay)
    .first('id');
  return !!row;
}
