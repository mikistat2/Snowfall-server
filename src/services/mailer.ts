import nodemailer from 'nodemailer';
import { env } from '../config/env';

/**
 * Shared Gmail SMTP transport (feedback mails + platform alerts).
 * Disabled until SMTP_USER + SMTP_PASS (App Password) are set.
 */

let transporter: nodemailer.Transporter | null = null;

export function getTransport(): nodemailer.Transporter | null {
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
