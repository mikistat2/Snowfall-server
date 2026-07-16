import * as botManager from './botManager';
import * as notificationModel from '../models/notificationModel';
import * as userModel from '../models/userModel';
import type { NotificationType } from '../models/notificationModel';
import type { MemberRow } from '../types';

/**
 * Every send attempt is logged in `notifications`:
 *   sent                — delivered to Telegram
 *   failed              — bot API rejected it (blocked bot, bad chat, …)
 *   skipped_no_chat_id  — member has not linked Telegram yet (surfaced in UI)
 * Gyms with no bot configured are skipped silently (nothing was attempted).
 */

export async function sendToMember(
  gymId: number,
  member: Pick<MemberRow, 'id' | 'telegram_chat_id'>,
  type: NotificationType,
  text: string,
  extraPayload: Record<string, unknown> = {},
): Promise<void> {
  const entry = botManager.getBot(gymId);
  if (!entry) return; // no bot configured for this gym

  if (!member.telegram_chat_id) {
    await notificationModel.create({
      gym_id: gymId,
      member_id: member.id,
      type,
      status: 'skipped_no_chat_id',
      payload: { text, ...extraPayload },
    });
    return;
  }

  try {
    await entry.bot.api.sendMessage(Number(member.telegram_chat_id), text);
    await notificationModel.create({
      gym_id: gymId,
      member_id: member.id,
      type,
      status: 'sent',
      payload: { text, ...extraPayload },
    });
  } catch (err) {
    await notificationModel.create({
      gym_id: gymId,
      member_id: member.id,
      type,
      status: 'failed',
      payload: { text, error: err instanceof Error ? err.message : String(err), ...extraPayload },
    });
  }
}

/** Admin alerts / summaries go to every linked owner chat of the gym. */
export async function sendToOwners(
  gymId: number,
  type: Extract<NotificationType, 'admin_alert' | 'admin_summary'>,
  text: string,
  extraPayload: Record<string, unknown> = {},
): Promise<void> {
  const entry = botManager.getBot(gymId);
  if (!entry) return;

  const chatIds = await userModel.ownerChatIds(gymId);
  if (chatIds.length === 0) {
    await notificationModel.create({
      gym_id: gymId,
      type,
      status: 'skipped_no_chat_id',
      payload: { text, ...extraPayload },
    });
    return;
  }

  let anyFailed: string | null = null;
  for (const chatId of chatIds) {
    try {
      await entry.bot.api.sendMessage(chatId, text);
    } catch (err) {
      anyFailed = err instanceof Error ? err.message : String(err);
    }
  }
  await notificationModel.create({
    gym_id: gymId,
    type,
    status: anyFailed ? 'failed' : 'sent',
    payload: { text, ...(anyFailed ? { error: anyFailed } : {}), ...extraPayload },
  });
}
