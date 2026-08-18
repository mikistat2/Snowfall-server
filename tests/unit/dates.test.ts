import { describe, expect, it } from 'vitest';
import { types } from 'pg';
import { addDays, dateAtNoonUtc, dateOnly, dateOnlyUtc, daysBetween } from '../../src/utils/dates';

describe('membership length', () => {
  it('gives a package exactly its own number of days', () => {
    expect(addDays('2026-08-18', 60)).toBe('2026-10-17');
    expect(addDays('2026-08-18', 15)).toBe('2026-09-02');
    expect(daysBetween('2026-08-18', addDays('2026-08-18', 60))).toBe(60);
    expect(daysBetween('2026-08-18', addDays('2026-08-18', 15))).toBe(15);
  });

  it('counts across a month boundary and a leap day', () => {
    expect(addDays('2028-01-31', 30)).toBe('2028-03-01'); // 2028 is a leap year
    expect(addDays('2026-12-20', 60)).toBe('2027-02-18');
  });
});

describe('date-only values crossing the wire', () => {
  /**
   * The bug this pins: a Postgres DATE used to arrive as a JS Date at *local*
   * midnight, and `res.json()` then wrote it out as UTC. East of UTC that moved
   * the calendar day back one, so a 60-day package read as 59 days left.
   */
  it('reads a DATE column back as the raw "YYYY-MM-DD" string', async () => {
    await import('../../src/db/knex'); // registers the parsers as a side effect
    const parse = types.getTypeParser(types.builtins.DATE) as (value: string) => unknown;
    expect(parse('2026-10-17')).toBe('2026-10-17');
  });

  it('keeps the calendar day of a timestamp column through a JSON round-trip', () => {
    // members.joined_at is TIMESTAMPTZ; noon UTC is >12h from every timezone
    // edge, so the day cannot slip whichever side of UTC the server sits on.
    const stored = dateAtNoonUtc('2026-06-01');
    expect(JSON.parse(JSON.stringify({ at: stored })).at.slice(0, 10)).toBe('2026-06-01');
    expect(dateOnlyUtc(stored)).toBe('2026-06-01');
  });

  it('agrees with dateOnly for a timestamp taken in the middle of the day', () => {
    const noon = new Date(2026, 7, 18, 12, 0, 0);
    expect(dateOnly(noon)).toBe('2026-08-18');
  });
});
