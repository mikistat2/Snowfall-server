"use strict";
/**
 * Tracks when the API last served a real request, so the keep-alive job
 * (jobs/index.ts) can warm an autosuspending database while staff are using it
 * and let it suspend when they are not, and so the sweep gates below can skip
 * passes that provably have no work.
 *
 * Why not a fixed opening-hours window: the server clock is whatever the host
 * runs (Render is UTC, the gyms are UTC+3), so a hardcoded window silently
 * warms the wrong three hours, and it pays for every empty hour inside the
 * window regardless. Real traffic needs no timezone and no configuration.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.KEEPALIVE_INTERVAL_MINUTES = void 0;
exports.markActivity = markActivity;
exports.isRecentlyActive = isRecentlyActive;
exports.createSweepGate = createSweepGate;
/** Ping cadence. Must stay below the provider's autosuspend delay (Neon: 5 min). */
exports.KEEPALIVE_INTERVAL_MINUTES = 4;
/**
 * How long after the last request we keep the database warm. Long enough to
 * cover a front desk between walk-ins, short enough that a closed gym stops
 * paying for compute within the half hour.
 */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000;
let lastRequestAt = 0;
/** Called per request by the activity middleware. */
function markActivity() {
    lastRequestAt = Date.now();
    wakeSweeps();
}
/** True when someone has hit the API recently enough to keep warming for. */
function isRecentlyActive() {
    return lastRequestAt > 0 && Date.now() - lastRequestAt < ACTIVE_WINDOW_MS;
}
const gates = [];
function createSweepGate(maxIdleMs) {
    let pending = true; // a fresh process has not verified anything yet
    let lastRunAt = 0;
    const gate = {
        shouldRun: () => pending || Date.now() - lastRunAt >= maxIdleMs,
        start: () => {
            lastRunAt = Date.now();
            return lastRunAt;
        },
        finish: (token, didWork) => {
            // Only go quiet when the pass found nothing AND nothing arrived while it
            // was running — otherwise that request's work would be skipped next time.
            if (!didWork && lastRequestAt < token)
                pending = false;
        },
        markPending: () => {
            pending = true;
        },
    };
    gates.push(gate);
    return gate;
}
/** Any request may have created work for the sweeps. */
function wakeSweeps() {
    for (const gate of gates)
        gate.markPending();
}
//# sourceMappingURL=activity.js.map