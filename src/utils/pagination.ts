/**
 * Optional page params from a query string.
 *
 * Both are undefined when absent, which every model treats as "no limit" —
 * the desktop tables still get the full result set, so adding paging did not
 * change any existing response.
 */

const MAX_LIMIT = 200;

export function parseLimit(raw: unknown): number | undefined {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(Math.floor(value), MAX_LIMIT);
}

export function parseOffset(raw: unknown): number | undefined {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}
