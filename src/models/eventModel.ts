import type { Knex } from 'knex';
import { db } from '../db/knex';
import type { Severity } from '../types';

export interface EventRow {
  id: number;
  gym_id: number;
  type: string;
  severity: Severity;
  message: string;
  member_id: number | null;
  created_at: Date;
}

export async function create(
  data: { gym_id: number; type: string; severity: Severity; message: string; member_id?: number | null },
  trx: Knex = db,
): Promise<EventRow> {
  const [row] = await trx('events').insert(data).returning('*');
  return row;
}

export async function listRecent(gymId: number, limit = 50): Promise<EventRow[]> {
  return db('events').where({ gym_id: gymId }).orderBy('created_at', 'desc').limit(limit);
}
