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

export type PlatformAction = 'freeze' | 'unfreeze' | 'delete';

const MESSAGES: Record<PlatformAction, { subject: string; body: (gym: string, note?: string) => string }> = {
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
