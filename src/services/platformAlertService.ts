import { db } from '../db/knex';
import { env } from '../config/env';
import { getTransport } from './mailer';
import * as notifier from '../telegram/notifier';
import * as botManager from '../telegram/botManager';
import * as userModel from '../models/userModel';
import * as billingModel from '../models/billingModel';

/**
 * Alerts a gym's owner(s) when the platform admin acts on their account
 * (freeze / unfreeze / delete), so tenants are never locked out silently.
 *
 * Channels, best effort — a failed alert never blocks the admin action:
 *  - Telegram: via the gym's own bot to every linked owner chat (also logged
 *    in `notifications`, so it shows on their Notifications page).
 *  - Email: to every owner account's email via Gmail SMTP (works even while
 *    frozen, so this is the reliable channel).
 */

export type PlatformAction = 'freeze' | 'unfreeze' | 'delete' | 'approve' | 'renew';

const MESSAGES: Record<PlatformAction, { subject: string; body: (gym: string, note?: string) => string }> = {
  approve: {
    subject: 'Your gym registration has been approved 🎉',
    body: (gym, note) =>
      `🎉 Great news — your gym "${gym}" has been approved on the Snowfall platform!\n\n` +
      `You can now log in with the email and password you registered with.\n` +
      (note ? `Your subscription is valid until ${note}.\n` : '') +
      `\nWelcome aboard!`,
  },
  renew: {
    subject: 'Your subscription has been renewed',
    body: (gym, note) =>
      `✅ The subscription for your gym "${gym}" on Snowfall has been renewed` +
      (note ? ` and is now valid until ${note}` : '') +
      `. Thank you!`,
  },
  freeze: {
    subject: 'Your gym account has been frozen',
    body: (gym, note) =>
      `⚠️ Your gym "${gym}" on Snowfall has been temporarily frozen by the platform administrator.\n\n` +
      (note ? `Reason: ${note}\n\n` : '') +
      `While frozen, staff cannot log in and the system is unavailable. Your data (members, payments, history) is safe and nothing has been deleted.\n\n` +
      `To resolve this, please contact the platform administrator at ${env.platformAdmin.email}.`,
  },
  unfreeze: {
    subject: 'Your gym account has been reactivated',
    body: (gym) =>
      `✅ Good news — your gym "${gym}" on Snowfall has been reactivated. ` +
      `Staff can log in again and everything is back to normal. Thank you!`,
  },
  delete: {
    subject: 'Your gym account has been removed',
    body: (gym, note) =>
      `Your gym "${gym}" and its data have been permanently removed from the Snowfall platform.\n\n` +
      (note ? `Reason: ${note}\n\n` : '') +
      `If you believe this is a mistake, contact the platform administrator at ${env.platformAdmin.email}.`,
  },
};

export interface AlertResult {
  telegram: boolean;
  email: boolean;
}

export async function notifyGymOwners(
  gymId: number,
  gymName: string,
  action: PlatformAction,
  note?: string,
): Promise<AlertResult> {
  const { subject, body } = MESSAGES[action];
  return deliver(gymId, subject, body(gymName, note?.trim() || undefined), { platform_action: action });
}

/**
 * Both channels, best effort, never throwing — the platform action itself has
 * already happened by the time this runs and must not be undone by a mail
 * server being down.
 */
async function deliver(
  gymId: number,
  subject: string,
  text: string,
  meta: Record<string, unknown>,
): Promise<AlertResult> {
  const result: AlertResult = { telegram: false, email: false };

  // Telegram (gym's own bot → linked owner chats; also logged in
  // `notifications`, so it shows on the gym's Notifications page). For
  // 'delete' this runs before the row cascade-deletes — the chat message
  // still reaches the owner's phone.
  try {
    const hasBot = Boolean(botManager.getBot(gymId));
    const chatIds = hasBot ? await userModel.ownerChatIds(gymId) : [];
    await notifier.sendToOwners(gymId, 'admin_alert', text, meta);
    result.telegram = hasBot && chatIds.length > 0;
  } catch (err) {
    console.warn(`[platform-alert] telegram alert failed for gym ${gymId}:`, err);
  }

  // Email every owner account of the gym.
  try {
    const transport = getTransport();
    if (transport) {
      const owners: { name: string; email: string }[] = await db('users')
        .where({ gym_id: gymId, role: 'owner' })
        .select('name', 'email');
      for (const owner of owners) {
        await transport.sendMail({
          from: `"Snowfall Platform" <${env.mail.user}>`,
          to: `"${owner.name}" <${owner.email}>`,
          replyTo: env.platformAdmin.email,
          subject: `[Snowfall] ${subject}`,
          text,
        });
        result.email = true;
      }
    }
  } catch (err) {
    console.warn(`[platform-alert] email alert failed for gym ${gymId}:`, err);
  }

  return result;
}

/**
 * A feature was granted or revoked for one gym.
 *
 * Kept out of `MESSAGES` because the wording has to name the feature and say
 * what specifically stops working — "your account was changed" is exactly the
 * kind of alert that gets ignored until someone phones support.
 *
 * For a Telegram *revocation* the caller must send this BEFORE stopping the
 * bot, or the message has no bot left to go out through.
 */
export async function notifyFeatureChange(
  gymId: number,
  gymName: string,
  feature: 'camera' | 'telegram',
  allowed: boolean,
  note?: string,
): Promise<AlertResult> {
  const label = feature === 'camera' ? 'Face recognition' : 'Telegram notifications';
  const reason = note?.trim() ? `Reason: ${note.trim()}\n\n` : '';

  const subject = `${label} ${allowed ? 'enabled' : 'turned off'} for your gym`;
  const text = allowed
    ? `✅ ${label} has been switched back on for "${gymName}" on Snowfall.\n\n` +
      reason +
      (feature === 'camera'
        ? `Your enrolled faces were kept while it was off, so camera check-in works again straight away — ` +
          `re-enable it under Settings → Camera if you had switched it off yourself.\n\n`
        : `Your saved bot token was kept, so reminders and nudges start sending again automatically.\n\n`) +
      `Nothing else about your account has changed.`
    : `⚠️ ${label} has been turned off for "${gymName}" on Snowfall by the platform administrator.\n\n` +
      reason +
      (feature === 'camera'
        ? `What this means: the door camera and automatic face check-in stop working, and new members ` +
          `are enrolled without a face scan. Your gym keeps running in name-board mode — staff check ` +
          `members in from the members list.\n\n` +
          `Nothing has been deleted. Every enrolled face is kept and comes straight back if this is ` +
          `switched on again.\n\n`
        : `What this means: your bot stops sending expiry reminders, absence nudges and receipts. ` +
          `Members will not receive Telegram messages from your gym.\n\n` +
          `Nothing has been deleted. Your bot token is kept and reconnects if this is switched on again.\n\n`) +
      `To ask about this, contact the platform administrator at ${env.platformAdmin.email}.`;

  return deliver(gymId, subject, text, { platform_action: 'feature', feature, allowed });
}

/** Email the platform admin (you) — new registrations, expiring subscriptions, … */
export async function notifyPlatformAdmin(subject: string, text: string): Promise<void> {
  try {
    const transport = getTransport();
    if (!transport) return;
    await transport.sendMail({
      from: `"Snowfall Platform" <${env.mail.user}>`,
      to: env.platformAdmin.email,
      subject: `[Snowfall Admin] ${subject}`,
      text,
    });
  } catch (err) {
    console.warn('[platform-alert] admin email failed:', err);
  }
}

/** Days until a gym's subscription ends that trigger an admin reminder. */
const REMINDER_DAYS = new Set([30, 14, 7, 3, 1, 0]);

/**
 * Daily job: email the platform admin about yearly subscriptions (and free
 * trials) that are about to end or have just ended. Fires at 30/14/7/3/1/0
 * days remaining so the mailbox is not spammed every day.
 */
export async function runSubscriptionAlerts(): Promise<void> {
  const gyms: { id: number; name: string; is_trial: boolean; subscription_ends_at: Date }[] = await db('gyms')
    .where({ status: 'active' })
    .whereNotNull('subscription_ends_at')
    .select('id', 'name', 'is_trial', 'subscription_ends_at');

  const lines: string[] = [];
  for (const gym of gyms) {
    const daysLeft = Math.floor((new Date(gym.subscription_ends_at).getTime() - Date.now()) / 86_400_000);
    if (!REMINDER_DAYS.has(daysLeft)) continue;
    const kind = gym.is_trial ? 'FREE TRIAL' : 'yearly subscription';
    const when = daysLeft === 0 ? 'ends TODAY' : `ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
    lines.push(
      `• ${gym.name} (id ${gym.id}) — ${kind} ${when} (${new Date(gym.subscription_ends_at).toDateString()})`,
    );
  }
  if (lines.length === 0) return;

  await notifyPlatformAdmin(
    `${lines.length} gym subscription${lines.length === 1 ? '' : 's'} ending soon`,
    `The following gyms are approaching the end of their subscription:\n\n${lines.join('\n')}\n\n` +
      `Open your platform panel to renew, freeze or contact them.`,
  );
}

/**
 * Daily job: tell each gym OWNER their subscription is running out, so they
 * can renew themselves on the billing page instead of finding out by being
 * locked out.
 *
 * Silent unless the paywall is on — while payments are off nobody is going to
 * be locked out, and a "renew now" email would be a lie. Comped gyms are
 * skipped for the same reason. Fires on the same 30/14/7/3/1/0 ladder as the
 * admin alert, which also keeps it idempotent if the job runs twice in a day.
 */
export async function runOwnerRenewalReminders(): Promise<void> {
  const settings = await billingModel.getSettings();
  if (!settings.payments_required) return;

  const gyms: { id: number; name: string; is_trial: boolean; subscription_ends_at: Date }[] = await db('gyms')
    .where({ status: 'active', comped: false })
    .whereNotNull('subscription_ends_at')
    .select('id', 'name', 'is_trial', 'subscription_ends_at');

  for (const gym of gyms) {
    const endsAt = new Date(gym.subscription_ends_at);
    const daysLeft = Math.floor((endsAt.getTime() - Date.now()) / 86_400_000);
    if (!REMINDER_DAYS.has(daysLeft)) continue;

    const what = gym.is_trial ? 'free trial' : 'subscription';
    const when =
      daysLeft === 0
        ? `ends TODAY (${endsAt.toDateString()})`
        : `ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}, on ${endsAt.toDateString()}`;
    const grace =
      settings.grace_days > 0
        ? `\n\nYou have ${settings.grace_days} day${settings.grace_days === 1 ? '' : 's'} of grace after that date before access stops.`
        : '\n\nAccess stops on that date until a payment is verified.';

    const text =
      `Your ${what} for "${gym.name}" on Snowfall ${when}.\n\n` +
      `To keep going, log in and open the Billing page. You will find your payment code, the account to ` +
      `send the money to, and the exact amount. Paste the transaction ID or upload the receipt screenshot ` +
      `and your subscription extends immediately — no waiting for us.${grace}`;

    try {
      await notifier.sendToOwners(gym.id, 'admin_alert', text, { subscription_days_left: daysLeft });
    } catch (err) {
      console.warn(`[platform-alert] renewal telegram failed for gym ${gym.id}:`, err);
    }

    try {
      const transport = getTransport();
      if (!transport) continue;
      const owners: { name: string; email: string }[] = await db('users')
        .where({ gym_id: gym.id, role: 'owner' })
        .select('name', 'email');
      for (const owner of owners) {
        await transport.sendMail({
          from: `"Snowfall Platform" <${env.mail.user}>`,
          to: `"${owner.name}" <${owner.email}>`,
          replyTo: env.platformAdmin.email,
          subject: `[Snowfall] Your ${what} ${daysLeft === 0 ? 'ends today' : `ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`}`,
          text,
        });
      }
    } catch (err) {
      console.warn(`[platform-alert] renewal email failed for gym ${gym.id}:`, err);
    }
  }
}
