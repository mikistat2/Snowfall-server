import cron from 'node-cron';
import { KEEPALIVE_INTERVAL_MINUTES, createSweepGate, isRecentlyActive } from '../utils/activity';
import { db } from '../db/knex';
import { recomputeAllGyms } from '../services/statusService';
import * as checkInModel from '../models/checkInModel';
import * as gymModel from '../models/gymModel';
import * as occupancyService from '../services/occupancyService';
import * as notificationService from '../services/notificationService';
import * as guestModel from '../models/guestModel';
import * as platformAlert from '../services/platformAlertService';

/**
 * Jobs:
 *  - 00:05 daily: recompute every member's status per gym.
 *  - every 15 min: auto-checkout open sessions older than each gym's
 *    auto_checkout_hours, and everything after closing time.
 *  - 09:00 daily: Telegram expiry reminders + absence nudges.
 *  - every 10 min: daily closing summary to owners (once, after closing time).
 * (Phase 3 adds guest descriptor purge.)
 */

/**
 * Safety net for the two periodic sweeps: even with no signal at all, each one
 * still makes a full authoritative pass this often, so a missed wake-up
 * self-heals rather than parking a sweep indefinitely. Six hours is far below
 * the shortest deadline either job serves (a same-day closing summary) and far
 * above the cadence at which idle wake-ups would cost real compute.
 */
const SWEEP_SAFETY_MS = 6 * 60 * 60 * 1000;

const checkoutSweep = createSweepGate(SWEEP_SAFETY_MS);
const summarySweep = createSweepGate(SWEEP_SAFETY_MS);

export function startJobs(): void {
  startDbKeepAlive();

  cron.schedule('5 0 * * *', async () => {
    try {
      await recomputeAllGyms();
      const purged = await guestModel.purgeExpiredDescriptors();
      // eslint-disable-next-line no-console
      console.log(`[jobs] daily status recompute done, purged ${purged} expired guest descriptors`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[jobs] status recompute failed', err);
    }
  });

  cron.schedule('*/15 * * * *', async () => {
    if (!checkoutSweep.shouldRun()) return;
    const token = checkoutSweep.start();
    try {
      checkoutSweep.finish(token, await autoCheckout());
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[jobs] auto-checkout failed', err);
    }
  });

  cron.schedule('0 9 * * *', async () => {
    try {
      await notificationService.runExpiryReminders();
      await notificationService.runAbsenceNudges();
      // eslint-disable-next-line no-console
      console.log('[jobs] 09:00 reminders + nudges done');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[jobs] reminders failed', err);
    }
  });

  cron.schedule('*/10 * * * *', async () => {
    if (!summarySweep.shouldRun()) return;
    const token = summarySweep.start();
    try {
      summarySweep.finish(token, await notificationService.runClosingSummaries());
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[jobs] closing summary failed', err);
    }
  });

  // 08:00 daily: subscription reminders on the 30/14/7/3/1/0-days-left ladder
  // — to the PLATFORM admin (all gyms, one digest) and, when the paywall is
  // on, to each gym OWNER so they can renew themselves before being locked out.
  cron.schedule('0 8 * * *', async () => {
    try {
      await platformAlert.runSubscriptionAlerts();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[jobs] platform subscription alerts failed', err);
    }
    try {
      await platformAlert.runOwnerRenewalReminders();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[jobs] owner renewal reminders failed', err);
    }
  });
}


/**
 * Keeps the Neon compute from suspending while the app is in use.
 *
 * UptimeRobot's ping hits /health, which answers without touching Postgres —
 * so it keeps Render awake while the database still went cold after a few idle
 * minutes, and the first staff member to load a page paid the wake-up. This
 * runs a real (trivial) query on a cadence below Neon's autosuspend delay.
 *
 * It only fires while someone is actually using the API. A gym that closed an
 * hour ago stops being warmed, the compute suspends, and the monthly
 * compute-hour usage tracks real usage instead of a guessed opening schedule.
 */
function startDbKeepAlive(): void {
  cron.schedule(`*/${KEEPALIVE_INTERVAL_MINUTES} * * * *`, async () => {
    if (!isRecentlyActive()) return;
    try {
      await db.raw('SELECT 1');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[jobs] db keep-alive failed', err);
    }
  });
}

export async function autoCheckout(): Promise<boolean> {
  const gyms = await gymModel.listAll();
  const touched = new Set<number>();
  const now = new Date();

  for (const gym of gyms) {
    const settings = gymModel.getSettings(gym);

    // sessions older than this gym's auto_checkout_hours
    const stale = await checkInModel.autoCheckoutStale(gym.id, settings.auto_checkout_hours);
    stale.forEach((r) => touched.add(r.gym_id));

    // everything still open after closing time — one statement, not one
    // round-trip per open session
    const [h, m] = settings.closing_time.split(':').map(Number);
    const closing = new Date(now);
    closing.setHours(h ?? 22, m ?? 0, 0, 0);
    if (now >= closing) {
      const closed = await checkInModel.autoCheckoutAllOpen(gym.id);
      if (closed > 0) touched.add(gym.id);
    }
  }

  for (const gymId of touched) {
    await occupancyService.resync(gymId);
  }

  return touched.size > 0;
}
