import nodemailer from 'nodemailer';
import { env } from '../config/env';
import * as gymModel from '../models/gymModel';
import * as userModel from '../models/userModel';
import { badRequest } from '../utils/errors';

/**
 * Sends gym feedback straight to the product owner's inbox via Gmail SMTP.
 * Gym name + submitter contact are looked up server-side (not trusted from
 * the client) and attached, and reply-to is set to the submitter so replies
 * go back to the gym directly.
 *
 * Requires SMTP_USER + SMTP_PASS (a Gmail address + App Password) in the
 * server env; otherwise sending is disabled and the endpoint reports it.
 */

let transporter: nodemailer.Transporter | null = null;

function getTransport(): nodemailer.Transporter | null {
  if (!env.mail.user || !env.mail.pass) return null;
  transporter ??= nodemailer.createTransport({
    service: 'gmail',
    auth: { user: env.mail.user, pass: env.mail.pass },
  });
  return transporter;
}

export function isMailConfigured(): boolean {
  return getTransport() !== null;
}

const CATEGORY_LABELS: Record<string, string> = {
  suggestion: 'Suggestion',
  bug: 'Bug report',
  improvement: 'Improvement idea',
  other: 'Other',
};

export async function sendFeedback(input: {
  gymId: number;
  userId: number;
  category: string;
  subject: string;
  message: string;
}): Promise<void> {
  const transport = getTransport();
  if (!transport) {
    throw badRequest(
      'Feedback email is not configured on the server (set SMTP_USER and SMTP_PASS).',
      'mail_not_configured',
    );
  }

  const [gym, user] = await Promise.all([
    gymModel.findById(input.gymId),
    userModel.findById(input.userId),
  ]);

  const catLabel = CATEGORY_LABELS[input.category] ?? input.category;
  const subject = `[Snowfall GMS · ${catLabel}] ${input.subject || 'Feedback'}`;

  const lines = [
    input.message,
    '',
    '────────────────────────',
    `Type:    ${catLabel}`,
    `Gym:     ${gym?.name ?? '-'} (id ${input.gymId})`,
    `Phone:   ${gym?.phone ?? '-'}`,
    `From:    ${user?.name ?? '-'} <${user?.email ?? '-'}>`,
    `Role:    ${user?.role ?? '-'}`,
    `Sent:    ${new Date().toISOString()}`,
  ];

  await transport.sendMail({
    from: `"Snowfall GMS Feedback" <${env.mail.user}>`,
    to: env.mail.feedbackTo,
    replyTo: user?.email ? `"${user.name}" <${user.email}>` : undefined,
    subject,
    text: lines.join('\n'),
  });
}
