import cron from 'node-cron';
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
export function startJobs(): void {
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
    try {
      await autoCheckout();
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
    try {
      await notificationService.runClosingSummaries();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[jobs] closing summary failed', err);
    }
  });

  // 08:00 daily: email the PLATFORM admin about gym subscriptions/trials
  // ending soon (30/14/7/3/1/0 days left).
  cron.schedule('0 8 * * *', async () => {
    try {
      await platformAlert.runSubscriptionAlerts();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[jobs] platform subscription alerts failed', err);
    }
  });
}

export async function autoCheckout(): Promise<void> {
  const gyms = await gymModel.listAll();
  const touched = new Set<number>();
  const now = new Date();

  for (const gym of gyms) {
    const settings = gymModel.getSettings(gym);

    // sessions older than auto_checkout_hours
    const stale = await checkInModel.autoCheckoutStale(settings.auto_checkout_hours);
    stale.forEach((r) => touched.add(r.gym_id));

    // everything still open after closing time
    const [h, m] = settings.closing_time.split(':').map(Number);
    const closing = new Date(now);
    closing.setHours(h ?? 22, m ?? 0, 0, 0);
    if (now >= closing) {
      const open = await checkInModel.listOpen(gym.id);
      for (const session of open) {
        await checkInModel.checkout(session.id, 'auto');
        touched.add(gym.id);
      }
    }
  }

  for (const gymId of touched) {
    await occupancyService.resync(gymId);
  }
}
