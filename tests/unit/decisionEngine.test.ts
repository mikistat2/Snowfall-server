import { describe, it, expect } from 'vitest';
import {
  decideCheckIn,
  decideGuestPass,
  deriveStatus,
  computeRenewal,
  euclideanDistance,
  type DecisionInput,
} from '../../src/services/decisionEngine';
import { DEFAULT_SETTINGS } from '../../src/types';

// Fixed "now": 2026-07-14 10:00 local time.
const NOW = new Date(2026, 6, 14, 10, 0, 0);

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    frozen: false,
    expiresAt: '2026-08-01', // 18 days out
    sessionsPerDay: null,
    allowedHours: null,
    firstAllowedToday: null,
    now: NOW,
    settings: { ...DEFAULT_SETTINGS },
    ...overrides,
  };
}

describe('decideCheckIn', () => {
  it('allows an active member (green, days remaining)', () => {
    const d = decideCheckIn(input());
    expect(d).toMatchObject({ allowed: true, code: 'allowed', severity: 'green', derivedStatus: 'active' });
    expect(d.message).toBe('18 days remaining');
  });

  it('allows an expiring member (yellow) at exactly the reminder threshold', () => {
    const d = decideCheckIn(input({ expiresAt: '2026-07-21' })); // 7 days = reminder default
    expect(d).toMatchObject({ allowed: true, severity: 'yellow', derivedStatus: 'expiring' });
    expect(d.message).toBe('7 days remaining');
  });

  it('allows a grace-period member (yellow, overdue message)', () => {
    const d = decideCheckIn(input({ expiresAt: '2026-07-12' })); // 2 days overdue, grace=3
    expect(d).toMatchObject({ allowed: true, severity: 'yellow', derivedStatus: 'grace' });
    expect(d.message).toBe('in grace period · 2 days overdue');
  });

  it('treats expiry day itself as grace', () => {
    const d = decideCheckIn(input({ expiresAt: '2026-07-14' }));
    expect(d).toMatchObject({ allowed: true, derivedStatus: 'grace' });
    expect(d.message).toBe('in grace period · expires today');
  });

  it('denies once past the grace period (red, expired message)', () => {
    const d = decideCheckIn(input({ expiresAt: '2026-07-10' })); // 4 days overdue > grace 3
    expect(d).toMatchObject({ allowed: false, code: 'denied_expired', severity: 'red', derivedStatus: 'expired' });
    expect(d.message).toBe('expired 4 days ago · renew?');
  });

  it('denies at exactly grace boundary + 1', () => {
    // grace_period_days=3 → daysLeft=-3 is still grace, -4 is expired
    expect(decideCheckIn(input({ expiresAt: '2026-07-11' })).allowed).toBe(true);
    expect(decideCheckIn(input({ expiresAt: '2026-07-10' })).allowed).toBe(false);
  });

  it('denies a member who never had a subscription', () => {
    const d = decideCheckIn(input({ expiresAt: null }));
    expect(d).toMatchObject({ allowed: false, code: 'denied_expired', severity: 'red' });
    expect(d.message).toBe('no subscription · enroll or renew');
  });

  it('denies a frozen membership (red) even with days remaining', () => {
    const d = decideCheckIn(input({ frozen: true }));
    expect(d).toMatchObject({ allowed: false, code: 'denied_frozen', severity: 'red', derivedStatus: 'frozen' });
    expect(d.message).toBe('membership frozen');
  });

  it('denies a second entry on a 1-session-per-day plan (orange, entry time)', () => {
    const first = new Date(2026, 6, 14, 7, 5);
    const d = decideCheckIn(input({ sessionsPerDay: 1, firstAllowedToday: first }));
    expect(d).toMatchObject({ allowed: false, code: 'denied_session_limit', severity: 'orange' });
    expect(d.message).toBe('already entered at 07:05');
  });

  it('allows a second entry on an unlimited plan', () => {
    const d = decideCheckIn(input({ sessionsPerDay: null, firstAllowedToday: new Date(2026, 6, 14, 7, 5) }));
    expect(d.allowed).toBe(true);
  });

  it('denies outside allowed hours (orange)', () => {
    const d = decideCheckIn(input({ allowedHours: '06:00-09:00' })); // now = 10:00
    expect(d).toMatchObject({ allowed: false, code: 'denied_hours', severity: 'orange' });
    expect(d.message).toBe('outside allowed hours (06:00-09:00)');
  });

  it('allows inside the allowed-hours window (boundary inclusive)', () => {
    expect(decideCheckIn(input({ allowedHours: '06:00-10:00' })).allowed).toBe(true);
    expect(decideCheckIn(input({ allowedHours: '10:00-12:00' })).allowed).toBe(true);
  });

  it('expired beats session-limit and hours checks', () => {
    const d = decideCheckIn(
      input({
        expiresAt: '2026-07-01',
        sessionsPerDay: 1,
        firstAllowedToday: new Date(2026, 6, 14, 7, 0),
        allowedHours: '06:00-09:00',
      }),
    );
    expect(d.code).toBe('denied_expired');
  });

  it('session-limit beats hours check (spec order)', () => {
    const d = decideCheckIn(
      input({
        sessionsPerDay: 1,
        firstAllowedToday: new Date(2026, 6, 14, 7, 0),
        allowedHours: '06:00-09:00',
      }),
    );
    expect(d.code).toBe('denied_session_limit');
  });
});

describe('deriveStatus', () => {
  const s = DEFAULT_SETTINGS;
  it('maps day ranges to statuses', () => {
    expect(deriveStatus(30, s, false)).toBe('active');
    expect(deriveStatus(8, s, false)).toBe('active');
    expect(deriveStatus(7, s, false)).toBe('expiring');
    expect(deriveStatus(1, s, false)).toBe('expiring');
    expect(deriveStatus(0, s, false)).toBe('grace');
    expect(deriveStatus(-3, s, false)).toBe('grace');
    expect(deriveStatus(-4, s, false)).toBe('expired');
    expect(deriveStatus(null, s, false)).toBe('expired');
    expect(deriveStatus(30, s, true)).toBe('frozen');
  });
});

describe('computeRenewal (rollover)', () => {
  it('extends from the current expiry when still valid', () => {
    const r = computeRenewal('2026-08-01', NOW, 30);
    expect(r.expiresAt).toBe('2026-08-31');
  });

  it('starts from today when already expired', () => {
    const r = computeRenewal('2026-06-01', NOW, 30);
    expect(r.startsAt).toBe('2026-07-14');
    expect(r.expiresAt).toBe('2026-08-13');
  });

  it('starts from today when expiring today', () => {
    const r = computeRenewal('2026-07-14', NOW, 30);
    expect(r.expiresAt).toBe('2026-08-13');
  });

  it('starts from today when there is no previous subscription', () => {
    const r = computeRenewal(null, NOW, 90);
    expect(r.startsAt).toBe('2026-07-14');
    expect(r.expiresAt).toBe('2026-10-12');
  });
});

describe('decideGuestPass', () => {
  it('allows a guest with a valid same-day pass (blue)', () => {
    const d = decideGuestPass(new Date(2026, 6, 14, 23, 59, 59), NOW);
    expect(d).toMatchObject({ allowed: true, code: 'allowed', severity: 'blue' });
    expect(d.message).toBe('guest pass · valid today');
  });

  it('shows the end date for multi-day trial passes', () => {
    const d = decideGuestPass(new Date(2026, 6, 17, 23, 59, 59), NOW);
    expect(d.allowed).toBe(true);
    expect(d.message).toBe('guest pass · valid until 2026-07-17');
  });

  it('denies an expired pass (red)', () => {
    const d = decideGuestPass(new Date(2026, 6, 13, 23, 59, 59), NOW);
    expect(d).toMatchObject({ allowed: false, code: 'denied_expired', severity: 'red' });
    expect(d.message).toBe('guest pass expired');
  });
});

describe('euclideanDistance', () => {
  it('is 0 for identical vectors and grows with difference', () => {
    const a = Array.from({ length: 128 }, (_, i) => i / 128);
    expect(euclideanDistance(a, a)).toBe(0);
    const b = a.map((v) => v + 0.1);
    expect(euclideanDistance(a, b)).toBeCloseTo(Math.sqrt(128 * 0.01), 5);
  });
});
