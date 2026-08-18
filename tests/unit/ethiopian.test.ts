import { describe, it, expect } from 'vitest';
import {
  ethiopianMonthLength,
  ethiopianToGregorian,
  gregorianToEthiopian,
  isEthiopianLeapYear,
  isValidEthiopianDate,
  toGregorianDateOnly,
} from '../../src/utils/ethiopian';

/**
 * Anchors that can be checked against a wall calendar: Ethiopian new year falls
 * on 11 September, and on 12 September in the year before a Gregorian leap year.
 */
const ANCHORS: [ethiopian: [number, number, number], gregorian: string][] = [
  [[2015, 1, 1], '2022-09-11'],
  [[2016, 1, 1], '2023-09-12'], // 2024 is a Gregorian leap year
  [[2017, 1, 1], '2024-09-11'],
  [[2018, 1, 1], '2025-09-11'],
  [[2013, 13, 5], '2021-09-10'], // last day of a common year (Pagume 5)
  [[2015, 13, 6], '2023-09-11'], // last day of a leap year (Pagume 6)
  [[2012, 7, 23], '2020-04-01'],
  [[2018, 12, 12], '2026-08-18'],
];

describe('ethiopian ↔ gregorian', () => {
  it.each(ANCHORS)('converts %j both ways', ([year, month, day], gregorian) => {
    expect(ethiopianToGregorian({ year, month, day })).toBe(gregorian);
    expect(gregorianToEthiopian(gregorian)).toEqual({ year, month, day });
  });

  it('round-trips every day across four decades', () => {
    const failures: string[] = [];
    for (const date = new Date(1990, 0, 1); date <= new Date(2030, 0, 1); date.setDate(date.getDate() + 1)) {
      const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
        date.getDate(),
      ).padStart(2, '0')}`;
      if (ethiopianToGregorian(gregorianToEthiopian(iso)) !== iso) failures.push(iso);
    }
    expect(failures).toEqual([]);
  });

  it('gives Pagume 6 days only in the year before a Gregorian leap year', () => {
    expect(isEthiopianLeapYear(2015)).toBe(true); // 2015 % 4 === 3 → 2016 EC starts 12 Sep
    expect(isEthiopianLeapYear(2016)).toBe(false);
    expect(ethiopianMonthLength(2015, 13)).toBe(6);
    expect(ethiopianMonthLength(2016, 13)).toBe(5);
    expect(ethiopianMonthLength(2016, 12)).toBe(30);
  });
});

describe('isValidEthiopianDate', () => {
  it('accepts real dates and rejects impossible ones', () => {
    expect(isValidEthiopianDate({ year: 2018, month: 12, day: 30 })).toBe(true);
    expect(isValidEthiopianDate({ year: 2018, month: 12, day: 31 })).toBe(false);
    expect(isValidEthiopianDate({ year: 2016, month: 13, day: 6 })).toBe(false); // common year
    expect(isValidEthiopianDate({ year: 2015, month: 13, day: 6 })).toBe(true); // leap year
    expect(isValidEthiopianDate({ year: 2018, month: 14, day: 1 })).toBe(false);
    expect(isValidEthiopianDate({ year: 2018, month: 1, day: 0 })).toBe(false);
  });
});

describe('toGregorianDateOnly', () => {
  it('normalises whichever calendar the paper register used', () => {
    expect(toGregorianDateOnly('2018-12-12', 'ethiopian')).toBe('2026-08-18');
    expect(toGregorianDateOnly('2026-08-18', 'gregorian')).toBe('2026-08-18');
    // single-digit parts as typed into three separate boxes
    expect(toGregorianDateOnly('2018-1-1', 'ethiopian')).toBe('2025-09-11');
  });

  it('returns null rather than a silently wrong date', () => {
    expect(toGregorianDateOnly('2025-02-30', 'gregorian')).toBeNull();
    expect(toGregorianDateOnly('2016-13-06', 'ethiopian')).toBeNull();
    expect(toGregorianDateOnly('not-a-date', 'gregorian')).toBeNull();
    expect(toGregorianDateOnly('2026-08', 'gregorian')).toBeNull();
  });
});
