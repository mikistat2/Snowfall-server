/**
 * Tracks when the API last served a real request, so the Neon keep-alive job
 * (jobs/index.ts) can warm the database while staff are using it and let it
 * suspend when they are not.
 *
 * Why not a fixed opening-hours window: the server clock is whatever the host
 * runs (Render is UTC, the gyms are UTC+3), so a hardcoded window silently
 * warms the wrong three hours, and it pays for every empty hour inside the
 * window regardless. Real traffic needs no timezone and no configuration.
 */

/** Ping cadence. Must stay below Neon's autosuspend delay (5 min default). */
export const KEEPALIVE_INTERVAL_MINUTES = 4;

/**
 * How long after the last request we keep the database warm. Long enough to
 * cover a front desk between walk-ins, short enough that a closed gym stops
 * paying for compute within the half hour.
 */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000;

let lastRequestAt = 0;

/** Called per request by the activity middleware. */
export function markActivity(): void {
  lastRequestAt = Date.now();
  wakeSweeps();
}

/** True when someone has hit the API recently enough to keep warming for. */
export function isRecentlyActive(): boolean {
  return lastRequestAt > 0 && Date.now() - lastRequestAt < ACTIVE_WINDOW_MS;
}

// --------------------------------------------------------------- sweeps ---

/**
 * Gate for the periodic sweeps (auto-checkout, closing summaries).
 *
 * Neon bills compute *uptime*, not queries, and suspends after a few idle
 * minutes. A cron that opens with an unconditional `gymModel.listAll()` every
 * 10 minutes therefore resets the suspend timer forever and holds the compute
 * up around the clock — the overwhelming majority of it at night, to discover
 * there is nothing to do.
 *
 * A sweep only has work when something happened, and the only things that can
 * happen are an API request (a check-in, a settings change) or time crossing a
 * threshold that some earlier request set up (closing time, a session going
 * stale). Both leave a trace in this process: no request since the last sweep
 * that found nothing to do means there is provably nothing to find now, so the
 * sweep can be skipped without touching the database at all.
 *
 * `maxIdleMs` forces a full pass anyway at a slow cadence, so a missed signal
 * self-heals instead of leaving a sweep parked forever.
 */
export interface SweepGate {
  /** False when the sweep can be skipped without querying. */
  shouldRun(): boolean;
  /** Call immediately before the sweep runs; returns a token for `finish`. */
  start(): number;
  /** Report whether the sweep actually found work. */
  finish(token: number, didWork: boolean): void;
}

const gates: { markPending(): void }[] = [];

export function createSweepGate(maxIdleMs: number): SweepGate {
  let pending = true; // a fresh process has not verified anything yet
  let lastRunAt = 0;

  const gate = {
    shouldRun: () => pending || Date.now() - lastRunAt >= maxIdleMs,
    start: () => {
      lastRunAt = Date.now();
      return lastRunAt;
    },
    finish: (token: number, didWork: boolean) => {
      // Only go quiet when the pass found nothing AND nothing arrived while it
      // was running — otherwise that request's work would be skipped next time.
      if (!didWork && lastRequestAt < token) pending = false;
    },
    markPending: () => {
      pending = true;
    },
  };

  gates.push(gate);
  return gate;
}

/** Any request may have created work for the sweeps. */
function wakeSweeps(): void {
  for (const gate of gates) gate.markPending();
}
