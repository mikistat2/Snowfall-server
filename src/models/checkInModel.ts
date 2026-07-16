import type { Knex } from 'knex';
import { db } from '../db/knex';
import type { CheckInRow, DecisionCode } from '../types';

export async function create(
  data: {
    gym_id: number;
    member_id?: number | null;
    guest_id?: number | null;
    decision: DecisionCode;
    confidence?: number | null;
    checked_in_at?: Date;
  },
  trx: Knex = db,
): Promise<CheckInRow> {
  const [row] = await trx('check_ins').insert(data).returning('*');
  return row;
}

/** First ALLOWED check-in for a member today (session-limit rule). */
export async function findAllowedToday(memberId: number, now: Date): Promise<CheckInRow | undefined> {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return db('check_ins')
    .where({ member_id: memberId })
    .whereIn('decision', ['allowed', 'override'])
    .where('checked_in_at', '>=', startOfDay)
    .orderBy('checked_in_at', 'asc')
    .first();
}

export async function countOpen(gymId: number): Promise<number> {
  const row = await db('check_ins')
    .where({ gym_id: gymId })
    .whereNull('checked_out_at')
    .whereIn('decision', ['allowed', 'override'])
    .count<{ count: string }>('id as count')
    .first();
  return Number(row?.count ?? 0);
}

export async function listOpen(
  gymId: number,
): Promise<(CheckInRow & { member_name: string | null; guest_name: string | null })[]> {
  return db('check_ins as c')
    .leftJoin('members as m', 'm.id', 'c.member_id')
    .leftJoin('guests as g', 'g.id', 'c.guest_id')
    .where('c.gym_id', gymId)
    .whereNull('c.checked_out_at')
    .whereIn('c.decision', ['allowed', 'override'])
    .select('c.*', 'm.full_name as member_name', 'g.name as guest_name')
    .orderBy('c.checked_in_at', 'desc');
}

export async function findById(gymId: number, id: number): Promise<CheckInRow | undefined> {
  return db('check_ins').where({ gym_id: gymId, id }).first();
}

/** The member's current open session, if they are inside right now. */
export async function findOpenByMember(memberId: number): Promise<CheckInRow | undefined> {
  return db('check_ins')
    .where({ member_id: memberId })
    .whereNull('checked_out_at')
    .whereIn('decision', ['allowed', 'override'])
    .orderBy('checked_in_at', 'desc')
    .first();
}

export async function checkout(
  id: number,
  method: 'camera' | 'auto' | 'manual',
  trx: Knex = db,
): Promise<CheckInRow | undefined> {
  const [row] = await trx('check_ins')
    .where({ id })
    .whereNull('checked_out_at')
    .update({ checked_out_at: trx.fn.now(), checkout_method: method })
    .returning('*');
  return row;
}

/** Auto-close open sessions older than `hours`. Returns affected gym ids. */
export async function autoCheckoutStale(hours: number): Promise<{ gym_id: number }[]> {
  return db('check_ins')
    .whereNull('checked_out_at')
    .where('checked_in_at', '<', new Date(Date.now() - hours * 60 * 60 * 1000))
    .update({ checked_out_at: db.fn.now(), checkout_method: 'auto' })
    .returning('gym_id');
}

export async function listRecentByMember(memberId: number, limit = 30): Promise<CheckInRow[]> {
  return db('check_ins').where({ member_id: memberId }).orderBy('checked_in_at', 'desc').limit(limit);
}

export async function countToday(gymId: number, now: Date): Promise<number> {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const row = await db('check_ins')
    .where({ gym_id: gymId })
    .whereIn('decision', ['allowed', 'override'])
    .where('checked_in_at', '>=', startOfDay)
    .count<{ count: string }>('id as count')
    .first();
  return Number(row?.count ?? 0);
}

/** Last allowed check-in per member of a gym (absence nudges). */
export async function lastCheckInPerMember(gymId: number): Promise<Map<number, Date>> {
  const rows = (await db('check_ins')
    .where({ gym_id: gymId })
    .whereNotNull('member_id')
    .whereIn('decision', ['allowed', 'override'])
    .select('member_id')
    .max('checked_in_at as last_at')
    .groupBy('member_id')) as unknown as { member_id: number; last_at: Date }[];
  return new Map(rows.map((r) => [r.member_id, r.last_at]));
}

/** Check-ins per hour over the last N days (dashboard peak-hours chart). */
export async function peakHours(gymId: number, days: number): Promise<{ hour: number; count: number }[]> {
  const rows = (await db('check_ins')
    .where({ gym_id: gymId })
    .whereIn('decision', ['allowed', 'override'])
    .where('checked_in_at', '>=', new Date(Date.now() - days * 24 * 60 * 60 * 1000))
    .select(db.raw('extract(hour from checked_in_at) as hour'))
    .count('id as count')
    .groupBy('hour')
    .orderBy('hour')) as unknown as { hour: string; count: string }[];
  return rows.map((r) => ({ hour: Number(r.hour), count: Number(r.count) }));
}
