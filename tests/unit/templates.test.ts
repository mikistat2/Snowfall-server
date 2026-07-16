import { describe, it, expect } from 'vitest';
import {
  absenceNudge,
  NUDGE_COUNT,
  trafficLabel,
  expiryReminder,
  dailySummary,
} from '../../src/telegram/templates';

describe('absence nudges', () => {
  it('has at least 5 templates', () => {
    expect(NUDGE_COUNT).toBeGreaterThanOrEqual(5);
  });

  it('rotates templates by index and wraps around', () => {
    const messages = Array.from({ length: NUDGE_COUNT }, (_, i) => absenceNudge(i, 'Abebe', 6, 'Demo Gym'));
    expect(new Set(messages).size).toBe(NUDGE_COUNT); // all distinct
    expect(absenceNudge(NUDGE_COUNT, 'Abebe', 6, 'Demo Gym')).toBe(messages[0]); // wraps
  });

  it('includes both English and Amharic text', () => {
    const msg = absenceNudge(0, 'Abebe', 6, 'Demo Gym');
    expect(msg).toMatch(/[A-Za-z]/);
    expect(msg).toMatch(/[ሀ-፿]/); // Ethiopic block
  });
});

describe('traffic label', () => {
  it('maps occupancy to quiet/moderate/busy', () => {
    expect(trafficLabel(0)).toBe('quiet');
    expect(trafficLabel(4)).toBe('quiet');
    expect(trafficLabel(5)).toBe('moderate');
    expect(trafficLabel(12)).toBe('moderate');
    expect(trafficLabel(13)).toBe('busy');
  });
});

describe('expiry reminder', () => {
  it('distinguishes days-before from expiry day', () => {
    expect(expiryReminder('Sara', 7, 'Demo Gym')).toContain('7 days');
    expect(expiryReminder('Sara', 0, 'Demo Gym')).toContain('today');
  });
});

describe('daily summary', () => {
  it('lists counts and truncates long expiring lists', () => {
    const msg = dailySummary({
      gymName: 'Demo Gym',
      checkIns: 42,
      revenue: 12500,
      expiringTomorrow: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
    });
    expect(msg).toContain('42');
    expect(msg).toContain('12,500');
    expect(msg).toContain('7 (');
    expect(msg).toContain('…');
  });
});
