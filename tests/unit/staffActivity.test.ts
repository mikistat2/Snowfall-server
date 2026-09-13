import { describe, it, expect } from 'vitest';
import { decide, WRITE_EVERY_MS } from '../../src/services/staffActivityService';
import { sourceOf } from '../../src/middleware/activity';

const MIN = 60 * 1000;
const T0 = 1_000_000_000_000;

describe('staff activity: when to write, and whether it is a new visit', () => {
  it('a person the process has never seen writes, and lets the database decide', () => {
    // First request after boot. Memory cannot say whether they were active a
    // minute ago on a previous process, so the stored last_seen_at must.
    expect(decide(undefined, T0)).toEqual({ write: true, mode: 'unknown' });
  });

  it('coming back after 30 minutes is a new visit, written immediately', () => {
    const seen = { lastActivity: T0, lastWrite: T0 };
    expect(decide(seen, T0 + 30 * MIN)).toEqual({ write: true, mode: 'new' });
    expect(decide(seen, T0 + 3 * 60 * MIN)).toEqual({ write: true, mode: 'new' });
  });

  it('29 minutes away is still the same visit', () => {
    const seen = { lastActivity: T0, lastWrite: T0 };
    expect(decide(seen, T0 + 29 * MIN).mode).toBe('continue');
  });

  it('a burst of requests while the app opens does not write each one', () => {
    const seen = { lastActivity: T0, lastWrite: T0 };
    expect(decide(seen, T0 + 1)).toEqual({ write: false, mode: 'continue' });
    expect(decide(seen, T0 + 30 * 1000)).toEqual({ write: false, mode: 'continue' });
  });

  it('a long working session refreshes last_seen_at every few minutes, without counting visits', () => {
    // Active the whole time, so lastActivity is always recent; only the write
    // throttle has elapsed.
    const seen = { lastActivity: T0 + WRITE_EVERY_MS - 1000, lastWrite: T0 };
    expect(decide(seen, T0 + WRITE_EVERY_MS)).toEqual({ write: true, mode: 'continue' });
  });

  it('the gap is measured from the last request, not the last write', () => {
    // Wrote at T0, kept working until T0+25m, left, came back at T0+50m: only
    // 25 minutes away, so it is not a new visit even though the last write
    // was 50 minutes ago.
    const seen = { lastActivity: T0 + 25 * MIN, lastWrite: T0 };
    expect(decide(seen, T0 + 50 * MIN).mode).toBe('continue');
  });
});

describe('staff activity: app or website', () => {
  it('recognises the Android and iOS app origins', () => {
    expect(sourceOf('https://localhost')).toBe('app');
    expect(sourceOf('capacitor://localhost')).toBe('app');
  });

  it('treats the website as web', () => {
    expect(sourceOf('https://www.snowfallgms.com')).toBe('web');
    expect(sourceOf('https://snowfallgms.com')).toBe('web');
  });

  it('does not mistake a local web dev server for the app', () => {
    // http://localhost is a native origin; http://localhost:5173 is Vite.
    expect(sourceOf('http://localhost:5173')).toBe('web');
  });

  it('counts a request with no Origin as web', () => {
    expect(sourceOf(undefined)).toBe('web');
  });
});
