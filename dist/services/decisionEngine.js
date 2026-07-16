"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deriveStatus = deriveStatus;
exports.decideCheckIn = decideCheckIn;
exports.computeRenewal = computeRenewal;
exports.decideGuestPass = decideGuestPass;
exports.euclideanDistance = euclideanDistance;
const dates_1 = require("../utils/dates");
/** Membership status derived purely from dates + settings. */
function deriveStatus(daysLeft, settings, frozen) {
    if (frozen)
        return 'frozen';
    if (daysLeft === null || daysLeft < -settings.grace_period_days)
        return 'expired';
    if (daysLeft <= 0)
        return 'grace';
    if (daysLeft <= settings.expiry_reminder_days)
        return 'expiring';
    return 'active';
}
function decideCheckIn(input) {
    const { settings, now } = input;
    const today = (0, dates_1.dateOnly)(now);
    const daysLeft = input.expiresAt === null ? null : (0, dates_1.daysBetween)(today, input.expiresAt);
    const status = deriveStatus(daysLeft, settings, input.frozen);
    if (status === 'frozen') {
        return deny('denied_frozen', 'membership frozen', daysLeft, status);
    }
    if (status === 'expired') {
        const message = daysLeft === null ? 'no subscription · enroll or renew' : `expired ${-daysLeft} days ago · renew?`;
        return deny('denied_expired', message, daysLeft, status);
    }
    // Membership is valid (active / expiring / grace) — now check plan limits.
    if (input.firstAllowedToday && input.sessionsPerDay === 1) {
        return {
            allowed: false,
            code: 'denied_session_limit',
            severity: 'orange',
            message: `already entered at ${(0, dates_1.formatTime)(input.firstAllowedToday)}`,
            daysRemaining: daysLeft,
            derivedStatus: status,
        };
    }
    if (input.allowedHours && !(0, dates_1.isWithinHours)(input.allowedHours, now)) {
        return {
            allowed: false,
            code: 'denied_hours',
            severity: 'orange',
            message: `outside allowed hours (${input.allowedHours})`,
            daysRemaining: daysLeft,
            derivedStatus: status,
        };
    }
    if (status === 'grace') {
        const overdue = -(daysLeft ?? 0);
        return allow('yellow', overdue === 0 ? 'in grace period · expires today' : `in grace period · ${overdue} days overdue`, daysLeft, status);
    }
    return allow(status === 'expiring' ? 'yellow' : 'green', `${daysLeft} days remaining`, daysLeft, status);
    function deny(code, message, days, s) {
        return { allowed: false, code, severity: 'red', message, daysRemaining: days, derivedStatus: s };
    }
    function allow(severity, message, days, s) {
        return { allowed: true, code: 'allowed', severity, message, daysRemaining: days, derivedStatus: s };
    }
}
/** Renewal rollover: new expiry = max(today, current expiry) + plan duration. */
function computeRenewal(currentExpiresAt, now, durationDays) {
    const today = (0, dates_1.dateOnly)(now);
    const base = currentExpiresAt !== null && (0, dates_1.daysBetween)(today, currentExpiresAt) > 0 ? currentExpiresAt : today;
    const startsAt = (0, dates_1.dateOnly)(typeof base === 'string' ? new Date(`${base}T00:00:00`) : base);
    return { startsAt, expiresAt: addDaysStr(startsAt, durationDays) };
}
function addDaysStr(date, days) {
    const d = new Date(`${date}T00:00:00`);
    d.setDate(d.getDate() + days);
    return (0, dates_1.dateOnly)(d);
}
/** Guest-pass decision: valid pass → allow (BLUE), otherwise deny (RED). */
function decideGuestPass(validUntil, now) {
    if (validUntil.getTime() >= now.getTime()) {
        const sameDay = (0, dates_1.dateOnly)(validUntil) === (0, dates_1.dateOnly)(now);
        return {
            allowed: true,
            code: 'allowed',
            severity: 'blue',
            message: sameDay ? 'guest pass · valid today' : `guest pass · valid until ${(0, dates_1.dateOnly)(validUntil)}`,
            daysRemaining: (0, dates_1.daysBetween)((0, dates_1.dateOnly)(now), (0, dates_1.dateOnly)(validUntil)),
            derivedStatus: 'active',
        };
    }
    return {
        allowed: false,
        code: 'denied_expired',
        severity: 'red',
        message: 'guest pass expired',
        daysRemaining: null,
        derivedStatus: 'expired',
    };
}
/** Euclidean distance between two 128-d descriptors. */
function euclideanDistance(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        const diff = (a[i] ?? 0) - (b[i] ?? 0);
        sum += diff * diff;
    }
    return Math.sqrt(sum);
}
//# sourceMappingURL=decisionEngine.js.map