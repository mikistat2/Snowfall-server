import { db } from '../db/knex';
import type { PlanRow } from '../types';

export interface PlanInput {
  name: string;
  duration_days: number;
  price: number;
  sessions_per_day: number | null;
  includes: Record<string, boolean>;
  allowed_hours: string | null;
  active?: boolean;
}

export async function listByGym(gymId: number, activeOnly = false): Promise<PlanRow[]> {
  const q = db('plans').where({ gym_id: gymId }).orderBy('id');
  if (activeOnly) q.andWhere({ active: true });
  return q;
}

export async function findById(gymId: number, id: number): Promise<PlanRow | undefined> {
  return db('plans').where({ gym_id: gymId, id }).first();
}

export async function create(gymId: number, data: PlanInput): Promise<PlanRow> {
  const [row] = await db('plans')
    .insert({ ...data, gym_id: gymId, includes: JSON.stringify(data.includes ?? {}) })
    .returning('*');
  return row;
}

export async function update(gymId: number, id: number, data: Partial<PlanInput>): Promise<PlanRow | undefined> {
  const patch: Record<string, unknown> = { ...data };
  if (data.includes !== undefined) patch.includes = JSON.stringify(data.includes);
  const [row] = await db('plans').where({ gym_id: gymId, id }).update(patch).returning('*');
  return row;
}

export async function isReferenced(id: number): Promise<boolean> {
  const row = await db('subscriptions').where({ plan_id: id }).first('id');
  return !!row;
}

export async function hardDelete(gymId: number, id: number): Promise<number> {
  return db('plans').where({ gym_id: gymId, id }).delete();
}
