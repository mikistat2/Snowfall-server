import { db } from '../db/knex';
import { env } from '../config/env';
import { getTransport } from './mailer';
import * as notifier from '../telegram/notifier';
import * as botManager from '../telegram/botManager';
import * as userModel from '../models/userModel';

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
  const text = body(gymName, note?.trim() || undefined);
  const result: AlertResult = { telegram: false, email: false };

  // Telegram (gym's own bot → linked owner chats; also logged in
  // `notifications`, so it shows on the gym's Notifications page). For
  // 'delete' this runs before the row cascade-deletes — the chat message
  // still reaches the owner's phone.
  try {
    const hasBot = Boolean(botManager.getBot(gymId));
    const chatIds = hasBot ? await userModel.ownerChatIds(gymId) : [];
    await notifier.sendToOwners(gymId, 'admin_alert', text, { platform_action: action });
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
