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
const NUDGE_DEDUPE_MS = 7 * DAY_MS;

/**
 * How late a reminder may still be delivered.
 *
 * This is the tolerance the whole design is built around: the server is not
 * guaranteed to be awake on any given day, so a milestone that was missed is
 * picked up on the next run instead of being lost. Beyond a week the message
 * has stopped being useful — somebody who lapsed ten days ago does not need to
 * be told today that their membership "expires tomorrow" — and the window also
 * bounds the query, so switching this on can never send a backlog.
 */
const CATCH_UP_DAYS = 7;

/**
 * Which of the three milestones to send, or null for nothing to say.
 *
 * Pure and exported so the decision can be tested against a table of days
 * rather than a database: this is the part that has to stay right, and it is
 * the part a passing integration test would quietly hide.
 *
 * Two rules, in this order:
 *   1. Take the MOST urgent milestone the member currently qualifies for.
 *      Thresholds, not dates — that is what lets a missed day be picked up.
 *   2. If that one has already gone out, say nothing. Deliberately do not fall
 *      back to a less urgent unsent milestone: once somebody has been told
 *      their membership lapsed, "expires in 7 days" is no longer true.
 */
export function pickMilestone(
  daysLeft: number,
  reminderDays: number,
  sent: Record<subscriptionModel.ReminderMilestone, Date | null>,
): subscriptionModel.ReminderMilestone | null {
  let milestone: subscriptionModel.ReminderMilestone | null = null;
  if (daysLeft <= reminderDays) milestone = 'ahead';
  if (daysLeft <= 0) milestone = 'due';
  if (daysLeft <= -1) milestone = 'grace';
  if (!milestone || sent[milestone]) return null;
  return milestone;
}

/**
 * Expiry reminders — three per membership period, each sent at most once:
 *   ahead  — from N days before expiry (N = settings.expiry_reminder_days)
 *   due    — from expiry day
 *   grace  — from the day after, when the grace period starts
 *
 * Each is a threshold, not a date. Missing a day no longer loses the message,
 * which is what makes this safe to run on an instance that sleeps.
 *
 * When several milestones are outstanding at once — the server was down for
 * three days — only the most urgent is sent and the rest are closed silently.
 * A member should hear where they stand today, not receive a three-message
 * backlog reciting a week they already lived through.
 *
 * What was sent is recorded on the subscription row, not looked up in
 * `notifications`: that table is pruned weekly, and a dedupe that forgets
 * would tell a lapsed member the same thing again every seven days forever.
 */
export async function runExpiryReminders(now = new Date()): Promise<void> {
  const today = dateOnly(now);

  for (const gym of await gymModel.listAll()) {
    if (!botManager.getBot(gym.id)) continue;
    const settings = gymModel.getSettings(gym);

    const candidates = await subscriptionModel.listReminderCandidates(
      gym.id,
      settings.expiry_reminder_days,
      CATCH_UP_DAYS,
    );

    for (const row of candidates) {
      const daysLeft = daysBetween(today, row.expires_at);

      const milestone = pickMilestone(daysLeft, settings.expiry_reminder_days, {
        ahead: row.reminded_ahead_at,
        due: row.reminded_due_at,
        grace: row.reminded_grace_at,
      });
      if (!milestone) continue;

      const text =
        milestone === 'grace'
          ? // Grace runs from the expiry date, so a late delivery has to say
            // how much is actually left, not repeat the full allowance.
            templates.enteredGrace(
              row.full_name,
              Math.max(settings.grace_period_days + daysLeft, 0),
              gym.name,
            )
          : // Never phrase a late "due" reminder as negative days remaining.
            templates.expiryReminder(row.full_name, Math.max(daysLeft, 0), gym.name);

      await notifier.sendToMember(
        gym.id,
        { id: row.member_id, telegram_chat_id: row.telegram_chat_id },
        milestone === 'grace' ? 'expired' : 'expiry_reminder',
        text,
        { days_left: daysLeft, milestone },
      );

      // Stamped whatever the delivery outcome was. sendToMember records a
      // failure or a missing chat id as a row and does not throw; retrying a
      // member who has never linked Telegram would just repeat that failure
      // every single day.
      await subscriptionModel.markReminded(row.subscription_id, milestone, now);
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
      .select('id', 'full_name', 'telegram_chat_id', 'joined_at', 'absence_nudge_count');

    for (const member of members) {
      const lastSeen = lastVisits.get(member.id) ?? member.joined_at;
      const daysAway = Math.floor((now.getTime() - new Date(lastSeen).getTime()) / DAY_MS);
      if (daysAway < settings.absence_nudge_days) continue;

      const lastNudge = await notificationModel.lastForMember(member.id, 'absence_nudge');
      if (lastNudge && now.getTime() - new Date(lastNudge.sent_at).getTime() < NUDGE_DEDUPE_MS) continue;

      // The rotation lives on the member row, not in `notifications` — that
      // table is pruned weekly, and counting it would restart every member at
      // the first template.
      await notifier.sendToMember(
        gym.id,
        member,
        'absence_nudge',
        templates.absenceNudge(member.absence_nudge_count, member.full_name, daysAway, gym.name),
        { days_away: daysAway },
      );
      await memberModel.bumpAbsenceNudgeCount(member.id);
    }
  }
}

/**
 * Runs every 10 minutes; when a gym passes its closing time and no summary
 * was sent today, the owner gets check-ins, revenue marked today, and
 * tomorrow's expiring members.
 */
export async function runClosingSummaries(now = new Date()): Promise<boolean> {
  let sent = false;
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
    sent = true;
  }
  return sent;
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
