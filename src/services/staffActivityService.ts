import * as staffActivityModel from '../models/staffActivityModel';
import type { ActivitySource, VisitMode } from '../models/staffActivityModel';
import { VISIT_GAP_MINUTES } from '../models/staffActivityModel';

/**
 * Turns the stream of authenticated requests into visit counts, without
 * writing to the database on every request.
 *
 * Opening the app fires a burst of requests (dashboard, members, billing…) and
 * a working session keeps firing them, so a write per request would be the
 * busiest write path in the system for the least valuable data. Instead the
 * process remembers when it last saw each person and writes only when:
 *   - a new visit begins (silence of VISIT_GAP_MINUTES or more), immediately;
 *   - or it has not written for them in WRITE_EVERY_MS, to keep last_seen_at
 *     current while they work.
 *
 * Memory is only an optimisation. After a restart the process knows nobody,
 * so the first request per person writes with mode 'unknown' and the stored
 * last_seen_at decides whether it is a new visit — a redeploy in the middle of
 * the day does not count everyone twice.
 */

const GAP_MS = VISIT_GAP_MINUTES * 60 * 1000;
/**
 * One minute, because the platform panel shows last activity to the minute
 * ("1m ago"). At five, someone working right now could read "4m ago" — wrong
 * by exactly the precision on display. Still at most one small write a minute
 * per active person, whatever their app is firing.
 */
export const WRITE_EVERY_MS = 60 * 1000;

interface Seen {
  /** Last request of any kind from this person on this source. */
  lastActivity: number;
  /** Last time that activity was written to the database. */
  lastWrite: number;
}

export interface Decision {
  write: boolean;
  mode: VisitMode;
}

/**
 * The whole policy, as a pure function of what the process remembers and the
 * current time. Kept free of I/O so it can be tested exhaustively.
 */
export function decide(seen: Seen | undefined, now: number): Decision {
  if (!seen) return { write: true, mode: 'unknown' };
  if (now - seen.lastActivity >= GAP_MS) return { write: true, mode: 'new' };
  return { write: now - seen.lastWrite >= WRITE_EVERY_MS, mode: 'continue' };
}

const memory = new Map<string, Seen>();

/** Caps the map on a long-lived process; entries this old decide nothing. */
const FORGET_AFTER_MS = 6 * 60 * 60 * 1000;
const PRUNE_ABOVE = 2000;

function forgetStale(now: number): void {
  for (const [key, seen] of memory) {
    if (now - seen.lastActivity > FORGET_AFTER_MS) memory.delete(key);
  }
}

/**
 * Note one authenticated request. Synchronous and never throws: usage
 * statistics must not be able to slow down or fail the request they describe.
 */
export function record(userId: number, gymId: number, source: ActivitySource, now = Date.now()): void {
  const key = `${userId}:${source}`;
  const seen = memory.get(key);
  const { write, mode } = decide(seen, now);

  memory.set(key, {
    lastActivity: now,
    lastWrite: write ? now : (seen?.lastWrite ?? now),
  });
  if (memory.size > PRUNE_ABOVE) forgetStale(now);

  if (!write) return;
  void staffActivityModel.touch(userId, gymId, source, mode).catch((err: unknown) => {
    // Forget the write so the next request retries it rather than waiting out
    // the throttle. For a lost 'new' this still counts the visit, because
    // 'unknown' lets the stored last_seen_at — still old — decide.
    memory.delete(key);
    // eslint-disable-next-line no-console
    console.warn('[activity] could not record staff activity:', err);
  });
}

/** Test hook: start from a process that remembers nobody. */
export function _resetMemory(): void {
  memory.clear();
}
