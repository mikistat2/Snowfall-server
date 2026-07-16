import type { DecisionCode, GymSettings, MemberStatus, Severity } from '../types';
import { dateOnly, daysBetween, formatTime, isWithinHours } from '../utils/dates';

/**
 * Pure check-in decision engine. No I/O — everything it needs is passed in,
 * so it is trivially unit-testable and always recomputes status from dates
 * (never trusts the stored member.status).
 */

export interface DecisionInput {
  frozen: boolean;
  /** Latest subscription expiry (date-only), null = never subscribed. */
  expiresAt: string | Date | null;
  sessionsPerDay: number | null;
  allowedHours: string | null;
  /** First allowed check-in today, if any (for the session-limit rule). */
  firstAllowedToday: Date | null;
  now: Date;
  settings: GymSettings;
}

export interface Decision {
  allowed: boolean;
  code: DecisionCode;
  severity: Severity;
  message: string;
  daysRemaining: number | null;
  derivedStatus: MemberStatus;
}

/** Membership status derived purely from dates + settings. */
export function deriveStatus(
  daysLeft: number | null,
  settings: GymSettings,
  frozen: boolean,
): MemberStatus {
  if (frozen) return 'frozen';
  if (daysLeft === null || daysLeft < -settings.grace_period_days) return 'expired';
  if (daysLeft <= 0) return 'grace';
  if (daysLeft <= settings.expiry_reminder_days) return 'expiring';
  return 'active';
}

export function decideCheckIn(input: DecisionInput): Decision {
  const { settings, now } = input;
  const today = dateOnly(now);
  const daysLeft = input.expiresAt === null ? null : daysBetween(today, input.expiresAt);
  const status = deriveStatus(daysLeft, settings, input.frozen);

  if (status === 'frozen') {
    return deny('denied_frozen', 'membership frozen', daysLeft, status);
  }

  if (status === 'expired') {
    const message =
      daysLeft === null ? 'no subscription · enroll or renew' : `expired ${-daysLeft} days ago · renew?`;
    return deny('denied_expired', message, daysLeft, status);
  }

  // Membership is valid (active / expiring / grace) — now check plan limits.
  if (input.firstAllowedToday && input.sessionsPerDay === 1) {
    return {
      allowed: false,
      code: 'denied_session_limit',
      severity: 'orange',
      message: `already entered at ${formatTime(input.firstAllowedToday)}`,
      daysRemaining: daysLeft,
      derivedStatus: status,
    };
  }

  if (input.allowedHours && !isWithinHours(input.allowedHours, now)) {
    return {
      allowed: false,
      code: 'denied_hours',
      severity: 'orange',
      message: `outside allowed hours (${input.allowedHours})`,
      daysRemaining: daysLeft,
      derivedStatus: status,
    };
  }

  if (status === 'grace') {
    const overdue = -(daysLeft ?? 0);
    return allow(
      'yellow',
      overdue === 0 ? 'in grace period · expires today' : `in grace period · ${overdue} days overdue`,
      daysLeft,
      status,
    );
  }

  return allow(
    status === 'expiring' ? 'yellow' : 'green',
    `${daysLeft} days remaining`,
    daysLeft,
    status,
  );

  function deny(code: DecisionCode, message: string, days: number | null, s: MemberStatus): Decision {
    return { allowed: false, code, severity: 'red', message, daysRemaining: days, derivedStatus: s };
  }

  function allow(severity: Severity, message: string, days: number | null, s: MemberStatus): Decision {
    return { allowed: true, code: 'allowed', severity, message, daysRemaining: days, derivedStatus: s };
  }
}

/** Renewal rollover: new expiry = max(today, current expiry) + plan duration. */
export function computeRenewal(
  currentExpiresAt: string | Date | null,
  now: Date,
  durationDays: number,
): { startsAt: string; expiresAt: string } {
  const today = dateOnly(now);
  const base =
    currentExpiresAt !== null && daysBetween(today, currentExpiresAt) > 0 ? currentExpiresAt : today;
  const startsAt = dateOnly(typeof base === 'string' ? new Date(`${base}T00:00:00`) : base);
  return { startsAt, expiresAt: addDaysStr(startsAt, durationDays) };
}

function addDaysStr(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return dateOnly(d);
}

/** Guest-pass decision: valid pass → allow (BLUE), otherwise deny (RED). */
export function decideGuestPass(validUntil: Date, now: Date): Decision {
  if (validUntil.getTime() >= now.getTime()) {
    const sameDay = dateOnly(validUntil) === dateOnly(now);
    return {
      allowed: true,
      code: 'allowed',
      severity: 'blue',
      message: sameDay ? 'guest pass · valid today' : `guest pass · valid until ${dateOnly(validUntil)}`,
      daysRemaining: daysBetween(dateOnly(now), dateOnly(validUntil)),
      derivedStatus: 'active',
    };
  }
  return {
    allowed: false,
    code: 'denied_expired',
    severity: 'red',
    message: 'guest pass expired',
    daysRemaining: null,
    derivedStatus: 'expired',
  };
}

/** Euclidean distance between two 128-d descriptors. */
export function euclideanDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}
