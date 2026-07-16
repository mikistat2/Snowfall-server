import * as checkInModel from '../models/checkInModel';
import { emitToGym } from '../sockets';

/**
 * In-memory occupancy counter per gym, backed by the DB (open check_ins).
 * Lazily initialized from the DB, adjusted on check-in/checkout, and
 * re-synced from the DB whenever the cron closes stale sessions.
 */
const counters = new Map<number, number>();

export async function getOccupancy(gymId: number): Promise<number> {
  const cached = counters.get(gymId);
  if (cached !== undefined) return cached;
  const count = await checkInModel.countOpen(gymId);
  counters.set(gymId, count);
  return count;
}

export async function adjust(gymId: number, delta: number): Promise<number> {
  const current = await getOccupancy(gymId);
  const next = Math.max(0, current + delta);
  counters.set(gymId, next);
  broadcast(gymId, next);
  return next;
}

/** Recount from the DB (used after bulk auto-checkout). */
export async function resync(gymId: number): Promise<number> {
  const count = await checkInModel.countOpen(gymId);
  counters.set(gymId, count);
  broadcast(gymId, count);
  return count;
}

function broadcast(gymId: number, count: number): void {
  emitToGym(gymId, 'occupancy:update', { count });
}
