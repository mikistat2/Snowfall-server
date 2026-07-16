import type { Knex } from 'knex';
import { db } from '../db/knex';

export interface AuditLogRow {
  id: number;
  gym_id: number;
  user_id: number | null;
  user_name: string | null;
  action: string;
  entity: string;
  entity_id: number | null;
  meta: Record<string, unknown>;
  created_at: Date;
}

export async function list(
  gymId: number,
  filter: { entity?: string; action?: string } = {},
  limit = 200,
): Promise<AuditLogRow[]> {
  const q = db('audit_logs as a')
    .leftJoin('users as u', 'u.id', 'a.user_id')
    .where('a.gym_id', gymId)
    .select('a.*', 'u.name as user_name')
    .orderBy('a.created_at', 'desc')
    .limit(limit);
  if (filter.entity) q.andWhere('a.entity', filter.entity);
  if (filter.action) q.andWhereILike('a.action', `%${filter.action}%`);
  return q;
}

export async function log(
  data: {
    gym_id: number;
    user_id: number | null;
    action: string;
    entity: string;
    entity_id?: number | null;
    meta?: Record<string, unknown>;
  },
  trx: Knex = db,
): Promise<void> {
  await trx('audit_logs').insert({ ...data, meta: JSON.stringify(data.meta ?? {}) });
}
