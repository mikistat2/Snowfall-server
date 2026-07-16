"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dateOnly = dateOnly;
exports.parseDateOnly = parseDateOnly;
exports.daysBetween = daysBetween;
exports.addDays = addDays;
exports.isWithinHours = isWithinHours;
exports.formatTime = formatTime;
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
//# sourceMappingURL=dates.js.map