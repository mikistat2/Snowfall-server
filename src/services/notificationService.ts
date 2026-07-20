import { db } from '../db/knex';
import * as gymModel from '../models/gymModel';
import * as subscriptionModel from '../models/subscriptionModel';
import * as checkInModel from '../models/checkInModel';
import * as notificationModel from '../models/notificationModel';
import * as memberModel from '../models/memberModel';
import * as paymentModel from '../models/paymentModel';
import * as botManager from '../telegram/botManager';
import * as notifier from '../telegram/notifier';
import * as templates from '../telegram/templates';
import { dateOnly, daysBetween } from '../utils/dates';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Same-type dedupe window for daily reminders (cron runs once a day at 09:00). */
const REMINDER_DEDUPE_MS = 20 * 60 * 60 * 1000;
const NUDGE_DEDUPE_MS = 7 * DAY_MS;

/**
 * 09:00 daily — expiry reminders:
 *   • N days before expiry (N = settings.expiry_reminder_days)
 *   • on expiry day
 *   • the day after expiry (entering the grace period)
 */
export async function runExpiryReminders(now = new Date()): Promise<void> {
  const today = dateOnly(now);
  for (const gym of await gymModel.listAll()) {
    if (!botManager.getBot(gym.id)) continue;
    const settings = gymModel.getSettings(gym);

    for (const row of await subscriptionModel.listLatestWithMemberForGym(gym.id)) {
      if (row.sub_status === 'frozen') continue;
      const daysLeft = daysBetween(today, row.expires_at);

      let type: 'expiry_reminder' | 'expired' | null = null;
      let text = '';
      if (daysLeft === settings.expiry_reminder_days || daysLeft === 0) {
        type = 'expiry_reminder';
        text = templates.expiryReminder(row.full_name, daysLeft, gym.name);
      } else if (daysLeft === -1) {
        type = 'expired';
        text = templates.enteredGrace(row.full_name, Math.max(settings.grace_period_days - 1, 0), gym.name);
      }
      if (!type) continue;

      const last = await notificationModel.lastForMember(row.member_id, type);
      if (last && now.getTime() - new Date(last.sent_at).getTime() < REMINDER_DEDUPE_MS) continue;

      await notifier.sendToMember(
        gym.id,
        { id: row.member_id, telegram_chat_id: row.telegram_chat_id },
        type,
        text,
        { days_left: daysLeft },
      );
    }
  }
}

/**
 * 09:00 daily — absence nudges: active/expiring members with no check-in for
 * settings.absence_nudge_days get ONE motivational message (rotating
 * templates), never twice within 7 days.
 */
export async function runAbsenceNudges(now = new Date()): Promise<void> {
  for (const gym of await gymModel.listAll()) {
    if (!botManager.getBot(gym.id)) continue;
    const settings = gymModel.getSettings(gym);
    // No camera → no check-ins are recorded, so "days away" is meaningless and
    // every member would look absent. Skip absence nudges for camera-less gyms.
    if (settings.camera_enabled === false) continue;
    const lastVisits = await checkInModel.lastCheckInPerMember(gym.id);

    const members = await db('members')
      .where({ gym_id: gym.id })
      .whereIn('status', ['active', 'expiring'])
      .select('id', 'full_name', 'telegram_chat_id', 'joined_at');

    for (const member of members) {
      const lastSeen = lastVisits.get(member.id) ?? member.joined_at;
      const daysAway = Math.floor((now.getTime() - new Date(lastSeen).getTime()) / DAY_MS);
      if (daysAway < settings.absence_nudge_days) continue;

      const lastNudge = await notificationModel.lastForMember(member.id, 'absence_nudge');
      if (lastNudge && now.getTime() - new Date(lastNudge.sent_at).getTime() < NUDGE_DEDUPE_MS) continue;

      const rotation = await notificationModel.countForMember(member.id, 'absence_nudge');
      await notifier.sendToMember(
        gym.id,
        member,
        'absence_nudge',
        templates.absenceNudge(rotation, member.full_name, daysAway, gym.name),
        { days_away: daysAway },
      );
    }
  }
}

/**
 * Runs every 10 minutes; when a gym passes its closing time and no summary
 * was sent today, the owner gets check-ins, revenue marked today, and
 * tomorrow's expiring members.
 */
export async function runClosingSummaries(now = new Date()): Promise<void> {
  for (const gym of await gymModel.listAll()) {
    if (!botManager.getBot(gym.id)) continue;
    const settings = gymModel.getSettings(gym);

    const [h, m] = settings.closing_time.split(':').map(Number);
    const closing = new Date(now);
    closing.setHours(h ?? 22, m ?? 0, 0, 0);
    if (now < closing) continue;
    if (await notificationModel.sentToGymToday(gym.id, 'admin_summary', now)) continue;

    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = dateOnly(new Date(now.getTime() + DAY_MS));

    const [checkIns, revenue, expiring] = await Promise.all([
      checkInModel.countToday(gym.id, now),
      paymentModel.revenueSince(gym.id, startOfDay),
      db('subscriptions as s')
        .join('members as m', 'm.id', 's.member_id')
        .where('s.gym_id', gym.id)
        .whereNot('s.status', 'frozen')
        .where('s.expires_at', tomorrow)
        .select('m.full_name'),
    ]);

    await notifier.sendToOwners(
      gym.id,
      'admin_summary',
      templates.dailySummary({
        gymName: gym.name,
        checkIns,
        revenue,
        expiringTomorrow: (expiring as { full_name: string }[]).map((e) => e.full_name),
      }),
      { check_ins: checkIns, revenue },
    );
  }
}

/**
 * Called after each unknown-face event: alert the owner once per day when an
 * unrecognized face has shown up 3+ times.
 */
export async function maybeAlertUnknownFace(gymId: number, now = new Date()): Promise<void> {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const row = await db('events')
    .where({ gym_id: gymId, type: 'unknown_face' })
    .where('created_at', '>=', startOfDay)
    .count<{ count: string }>('id as count')
    .first();
  const count = Number(row?.count ?? 0);
  if (count < 3) return;
  if (await notificationModel.sentToGymToday(gymId, 'admin_alert', now)) return;

  const gym = await gymModel.findById(gymId);
  if (!gym) return;
  await notifier.sendToOwners(gymId, 'admin_alert', templates.unknownFaceAlert(count, gym.name), {
    unknown_count: count,
  });
}

/** Telegram receipt after a marked payment (fire-and-forget from renew). */
export async function sendReceipt(input: {
  gymId: number;
  memberId: number;
  amount: string | number;
  planName: string;
  expiresAt: string;
  gymName: string;
}): Promise<void> {
  const member = await memberModel.findById(input.gymId, input.memberId);
  if (!member) return;
  await notifier.sendToMember(
    input.gymId,
    member,
    'receipt',
    templates.receipt(member.full_name, String(Number(input.amount)), input.planName, input.expiresAt, input.gymName),
    { amount: Number(input.amount), plan: input.planName },
  );
}
