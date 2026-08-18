"use strict";
/**
 * Ethiopian (Ge'ez) ↔ Gregorian date conversion.
 *
 * Ethiopian gyms keep their paper registers in the Ethiopian calendar, so a
 * back-filled membership arrives with dates like "Nehase 12, 2018". Everything
 * below the API boundary stores Gregorian date-only strings, and this module is
 * the single place the conversion happens on the way in.
 *
 * Algorithm: Beyene–Kudlek, via the Julian Day Number. 12 months of 30 days
 * plus Pagume (month 13) of 5 days, or 6 when `year % 4 === 3` — the Ethiopian
 * leap year sits one year before the Gregorian one.
 *
 * The client keeps a mirror of this file (client/src/lib/ethiopian.ts) purely
 * to preview the converted date under the input while the user types; this copy
 * is the authority for anything that reaches the database. Keep them in step.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isEthiopianLeapYear = isEthiopianLeapYear;
exports.ethiopianMonthLength = ethiopianMonthLength;
exports.isValidEthiopianDate = isValidEthiopianDate;
exports.ethiopianToGregorian = ethiopianToGregorian;
exports.gregorianToEthiopian = gregorianToEthiopian;
exports.toGregorianDateOnly = toGregorianDateOnly;
/** JDN of Ethiopian 0001-01-01 (Amete Mihret), minus the first-year offset. */
const JD_EPOCH_OFFSET_AMETE_MIHRET = 1723856;
function mod(a, b) {
    return ((a % b) + b) % b;
}
function gregorianToJdn(year, month, day) {
    const a = Math.floor((14 - month) / 12);
    const y = year + 4800 - a;
    const m = month + 12 * a - 3;
    return (day +
        Math.floor((153 * m + 2) / 5) +
        365 * y +
        Math.floor(y / 4) -
        Math.floor(y / 100) +
        Math.floor(y / 400) -
        32045);
}
function jdnToGregorian(jdn) {
    const a = jdn + 32044;
    const b = Math.floor((4 * a + 3) / 146097);
    const c = a - Math.floor((146097 * b) / 4);
    const d = Math.floor((4 * c + 3) / 1461);
    const e = c - Math.floor((1461 * d) / 4);
    const m = Math.floor((5 * e + 2) / 153);
    return {
        day: e - Math.floor((153 * m + 2) / 5) + 1,
        month: m + 3 - 12 * Math.floor(m / 10),
        year: 100 * b + d - 4800 + Math.floor(m / 10),
    };
}
function ethiopianToJdn(year, month, day) {
    return JD_EPOCH_OFFSET_AMETE_MIHRET + 365 + 365 * (year - 1) + Math.floor(year / 4) + 30 * month + day - 31;
}
function jdnToEthiopian(jdn) {
    const r = mod(jdn - JD_EPOCH_OFFSET_AMETE_MIHRET, 1461);
    const n = mod(r, 365) + 365 * Math.floor(r / 1460);
    return {
        year: 4 * Math.floor((jdn - JD_EPOCH_OFFSET_AMETE_MIHRET) / 1461) + Math.floor(r / 365) - Math.floor(r / 1460),
        month: Math.floor(n / 30) + 1,
        day: mod(n, 30) + 1,
    };
}
/** Pagume has a sixth day in the Ethiopian year before each Gregorian leap year. */
function isEthiopianLeapYear(year) {
    return mod(year, 4) === 3;
}
function ethiopianMonthLength(year, month) {
    if (month < 13)
        return 30;
    return isEthiopianLeapYear(year) ? 6 : 5;
}
function isValidEthiopianDate({ year, month, day }) {
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day))
        return false;
    if (year < 1 || month < 1 || month > 13 || day < 1)
        return false;
    return day <= ethiopianMonthLength(year, month);
}
const pad = (n) => String(n).padStart(2, '0');
/** Ethiopian date → Gregorian "YYYY-MM-DD". */
function ethiopianToGregorian(date) {
    const g = jdnToGregorian(ethiopianToJdn(date.year, date.month, date.day));
    return `${g.year}-${pad(g.month)}-${pad(g.day)}`;
}
/** Gregorian "YYYY-MM-DD" (or Date) → Ethiopian date parts. */
function gregorianToEthiopian(value) {
    const [y, m, d] = value instanceof Date
        ? [value.getFullYear(), value.getMonth() + 1, value.getDate()]
        : value.slice(0, 10).split('-').map(Number);
    return jdnToEthiopian(gregorianToJdn(y, m, d));
}
/**
 * Normalise a "YYYY-MM-DD" string written in either calendar to a Gregorian
 * "YYYY-MM-DD". Returns null when the parts do not name a real date, so the
 * caller can reject with a message naming the offending field.
 */
function toGregorianDateOnly(value, calendar) {
    const parts = value.slice(0, 10).split('-').map(Number);
    const [year, month, day] = parts;
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n)))
        return null;
    if (calendar === 'ethiopian') {
        const date = { year: year, month: month, day: day };
        return isValidEthiopianDate(date) ? ethiopianToGregorian(date) : null;
    }
    // Gregorian: round-trip through Date to reject 2025-02-30 and friends.
    const d = new Date(year, month - 1, day);
    if (d.getFullYear() !== year || d.getMonth() + 1 !== month || d.getDate() !== day)
        return null;
    return `${year}-${pad(month)}-${pad(day)}`;
}
//# sourceMappingURL=ethiopian.js.map