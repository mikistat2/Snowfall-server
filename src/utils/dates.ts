const DAY_MS = 24 * 60 * 60 * 1000;

/** "YYYY-MM-DD" in local time. */
export function dateOnly(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse "YYYY-MM-DD" as local midnight. Accepts Date (from pg) too. */
export function parseDateOnly(value: string | Date): Date {
  if (value instanceof Date) return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/** Whole days from `from` (date-only) to `to` (date-only). Positive = future. */
export function daysBetween(from: string | Date, to: string | Date): number {
  return Math.round((parseDateOnly(to).getTime() - parseDateOnly(from).getTime()) / DAY_MS);
}

export function addDays(date: string | Date, days: number): string {
  const d = parseDateOnly(date);
  d.setDate(d.getDate() + days);
  return dateOnly(d);
}

/** True if `now` falls inside an "HH:MM-HH:MM" window (local time). */
export function isWithinHours(window: string, now: Date): boolean {
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window);
  if (!match) return true; // malformed window: fail open
  const minutes = now.getHours() * 60 + now.getMinutes();
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  return minutes >= start && minutes <= end;
}

export function formatTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
