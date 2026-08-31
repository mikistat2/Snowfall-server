import { describe, expect, it } from 'vitest';
import { pickMilestone } from '../../src/services/notificationService';

const NONE = { ahead: null, due: null, grace: null };
const DAY = new Date('2026-08-30T09:00:00Z');
const REMINDER_DAYS = 7;

const pick = (daysLeft: number, sent = NONE) => pickMilestone(daysLeft, REMINDER_DAYS, sent);

describe('expiry reminder milestones', () => {
  it('says nothing while the membership is comfortably in date', () => {
    expect(pick(30)).toBeNull();
    expect(pick(8)).toBeNull();
  });

  it('walks the three milestones down to the grace period', () => {
    expect(pick(7)).toBe('ahead'); // reminder window opens
    expect(pick(1)).toBe('ahead');
    expect(pick(0)).toBe('due'); // expiry day
    expect(pick(-1)).toBe('grace'); // grace begins
  });

  it('never repeats a milestone that already went out', () => {
    expect(pick(5, { ...NONE, ahead: DAY })).toBeNull();
    expect(pick(0, { ...NONE, due: DAY })).toBeNull();
    expect(pick(-2, { ...NONE, grace: DAY })).toBeNull();
  });

  /**
   * The regression the whole change exists for: the old code matched
   * `daysLeft === reminderDays`, so a day the server slept through was lost
   * for good.
   */
  it('still fires for a day that was slept through', () => {
    // Server was down on day 7 — day 6 must not stay silent.
    expect(pick(6)).toBe('ahead');
    // Down through expiry day too — the member still hears, once.
    expect(pick(-1, NONE)).toBe('grace');
  });

  it('sends only the most urgent message after a multi-day outage', () => {
    // Three days offline: ahead, due and grace are all outstanding. The member
    // hears where they stand now, not a backlog of three messages.
    expect(pick(-3, NONE)).toBe('grace');
  });

  it('does not fall back to stale news once the member has been told', () => {
    // Grace already sent; "expires in 7 days" would be a lie, and the earlier
    // milestones must stay closed rather than fire late.
    expect(pick(-4, { ...NONE, grace: DAY })).toBeNull();
    expect(pick(-4, { ahead: null, due: null, grace: DAY })).toBeNull();
  });

  it('honours a gym that shortened its reminder window', () => {
    expect(pickMilestone(5, 3, NONE)).toBeNull(); // 5 days out, warns at 3
    expect(pickMilestone(3, 3, NONE)).toBe('ahead');
  });
});
