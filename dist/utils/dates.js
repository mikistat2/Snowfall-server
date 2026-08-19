"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dateOnly = dateOnly;
exports.parseDateOnly = parseDateOnly;
exports.daysBetween = daysBetween;
exports.addDays = addDays;
exports.isWithinHours = isWithinHours;
exports.formatTime = formatTime;
exports.dateAtNoonUtc = dateAtNoonUtc;
exports.dateOnlyUtc = dateOnlyUtc;
const DAY_MS = 24 * 60 * 60 * 1000;
/** "YYYY-MM-DD" in local time. */
function dateOnly(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
/** Parse "YYYY-MM-DD" as local midnight. Accepts Date (from pg) too. */
function parseDateOnly(value) {
    if (value instanceof Date)
        return new Date(value.getFullYear(), value.getMonth(), value.getDate());
    const [y, m, d] = value.slice(0, 10).split('-').map(Number);
    return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}
/** Whole days from `from` (date-only) to `to` (date-only). Positive = future. */
function daysBetween(from, to) {
    return Math.round((parseDateOnly(to).getTime() - parseDateOnly(from).getTime()) / DAY_MS);
}
function addDays(date, days) {
    const d = parseDateOnly(date);
    d.setDate(d.getDate() + days);
    return dateOnly(d);
}
/** True if `now` falls inside an "HH:MM-HH:MM" window (local time). */
function isWithinHours(window, now) {
    const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window);
    if (!match)
        return true; // malformed window: fail open
    const minutes = now.getHours() * 60 + now.getMinutes();
    const start = Number(match[1]) * 60 + Number(match[2]);
    const end = Number(match[3]) * 60 + Number(match[4]);
    return minutes >= start && minutes <= end;
}
function formatTime(d) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
/**
 * A date-only value on its way into a TIMESTAMPTZ column (`members.joined_at`).
 *
 * Midnight is the wrong instant to store: Postgres reads a bare "2026-06-01" in
 * the session's timezone and the JSON that comes back out is UTC, so the
 * calendar day can land on either side of the boundary depending on where the
 * server runs. Noon UTC is at least twelve hours from every timezone edge, so
 * the day survives the round-trip everywhere.
 */
function dateAtNoonUtc(value) {
    const iso = typeof value === 'string' ? value.slice(0, 10) : dateOnly(value);
    return new Date(`${iso}T12:00:00.000Z`);
}
/**
 * The calendar day of a TIMESTAMPTZ *as the client will see it*.
 *
 * `dateOnly` reads a timestamp in the server's local timezone, but the same
 * value reaches the browser as a UTC ISO string that the client slices to ten
 * characters. Reading it back in UTC is what keeps the two ends agreeing about
 * which day `members.joined_at` falls on, wherever the API happens to run.
 */
function dateOnlyUtc(value) {
    return new Date(value).toISOString().slice(0, 10);
}
//# sourceMappingURL=dates.js.map