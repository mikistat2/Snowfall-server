import type { Request, Response } from 'express';
import crypto from 'crypto';
import * as memberModel from '../models/memberModel';
import * as userModel from '../models/userModel';
import * as notificationModel from '../models/notificationModel';
import * as botManager from '../telegram/botManager';
import { badRequest, notFound } from '../utils/errors';
import type { NotificationStatus, NotificationType } from '../models/notificationModel';
import { pageParams, pagedBody } from '../utils/pagination';

function requireRunningBot(gymId: number): string {
  const status = botManager.getStatus(gymId);
  if (!status.running || !status.username) {
    throw badRequest(
      status.error
        ? `Telegram bot is not running: ${status.error}`
        : 'Configure a Telegram bot token in Settings first',
    );
  }
  return status.username;
}

/** One-time deep link for a member: t.me/<bot>?start=m<token> */
export async function memberLink(req: Request, res: Response): Promise<void> {
  const username = requireRunningBot(req.auth.gymId);
  const memberId = Number(req.params.id);
  const member = await memberModel.findById(req.auth.gymId, memberId);
  if (!member) throw notFound('Member not found');

  const token = crypto.randomBytes(12).toString('hex');
  await memberModel.setLinkToken(req.auth.gymId, memberId, token);
  res.json({
    url: `https://t.me/${username}?start=m${token}`,
    bot_username: username,
    already_linked: member.telegram_chat_id !== null,
  });
}

/** One-time deep link binding the current staff account's chat (admin alerts). */
export async function ownerLink(req: Request, res: Response): Promise<void> {
  const username = requireRunningBot(req.auth.gymId);
  const token = crypto.randomBytes(12).toString('hex');
  await userModel.setLinkToken(req.auth.gymId, req.auth.sub, token);
  res.json({ url: `https://t.me/${username}?start=a${token}`, bot_username: username });
}

export async function status(req: Request, res: Response): Promise<void> {
  const me = await userModel.findById(req.auth.sub);
  res.json({
    ...botManager.getStatus(req.auth.gymId),
    my_chat_linked: me?.telegram_chat_id != null,
  });
}

export async function notifications(req: Request, res: Response): Promise<void> {
  const result = await notificationModel.list(req.auth.gymId, {
    type: req.query.type as NotificationType | undefined,
    status: req.query.status as NotificationStatus | undefined,
    ...pageParams(req),
  });
  res.json(pagedBody(req, result));
}
