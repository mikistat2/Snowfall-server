"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.runExpiryReminders = runExpiryReminders;
exports.runAbsenceNudges = runAbsenceNudges;
exports.runClosingSummaries = runClosingSummaries;
exports.maybeAlertUnknownFace = maybeAlertUnknownFace;
exports.sendReceipt = sendReceipt;
const knex_1 = require("../db/knex");
const gymModel = __importStar(require("../models/gymModel"));
const subscriptionModel = __importStar(require("../models/subscriptionModel"));
const checkInModel = __importStar(require("../models/checkInModel"));
const notificationModel = __importStar(require("../models/notificationModel"));
const memberModel = __importStar(require("../models/memberModel"));
const paymentModel = __importStar(require("../models/paymentModel"));
const botManager = __importStar(require("../telegram/botManager"));
const notifier = __importStar(require("../telegram/notifier"));
const templates = __importStar(require("../telegram/templates"));
const dates_1 = require("../utils/dates");
const DAY_MS = 24 * 60 * 60 * 1000;
/** Same-type dedupe window for daily reminders (cron runs once a day at 09:00). */
const REMINDER_DEDUPE_MS = 20 * 60 * 60 * 1000;
const NUDGE_DEDUPE_MS = 7 * DAY_MS;
/**
 * 09:00 daily — expiry reminders:
 *   • N days before expiry (N = settings.expiry_reminder_days)
 *   • on expiry day
 *   • the day after expiry (entering the grace period)
 */
async function runExpiryReminders(now = new Date()) {
    const today = (0, dates_1.dateOnly)(now);
    for (const gym of await gymModel.listAll()) {
        if (!botManager.getBot(gym.id))
            continue;
        const settings = gymModel.getSettings(gym);
        for (const row of await subscriptionModel.listLatestWithMemberForGym(gym.id)) {
            if (row.sub_status === 'frozen')
                continue;
            const daysLeft = (0, dates_1.daysBetween)(today, row.expires_at);
            let type = null;
            let text = '';
            if (daysLeft === settings.expiry_reminder_days || daysLeft === 0) {
                type = 'expiry_reminder';
                text = templates.expiryReminder(row.full_name, daysLeft, gym.name);
            }
            else if (daysLeft === -1) {
                type = 'expired';
                text = templates.enteredGrace(row.full_name, Math.max(settings.grace_period_days - 1, 0), gym.name);
            }
            if (!type)
                continue;
            const last = await notificationModel.lastForMember(row.member_id, type);
            if (last && now.getTime() - new Date(last.sent_at).getTime() < REMINDER_DEDUPE_MS)
                continue;
            await notifier.sendToMember(gym.id, { id: row.member_id, telegram_chat_id: row.telegram_chat_id }, type, text, { days_left: daysLeft });
        }
    }
}
/**
 * 09:00 daily — absence nudges: active/expiring members with no check-in for
 * settings.absence_nudge_days get ONE motivational message (rotating
 * templates), never twice within 7 days.
 */
async function runAbsenceNudges(now = new Date()) {
    for (const gym of await gymModel.listAll()) {
        if (!botManager.getBot(gym.id))
            continue;
        const settings = gymModel.getSettings(gym);
        // No camera → no check-ins are recorded, so "days away" is meaningless and
        // every member would look absent. Skip absence nudges for camera-less gyms.
        if (settings.camera_enabled === false)
            continue;
        const lastVisits = await checkInModel.lastCheckInPerMember(gym.id);
        const members = await (0, knex_1.db)('members')
            .where({ gym_id: gym.id })
            .whereIn('status', ['active', 'expiring'])
            .select('id', 'full_name', 'telegram_chat_id', 'joined_at');
        for (const member of members) {
            const lastSeen = lastVisits.get(member.id) ?? member.joined_at;
            const daysAway = Math.floor((now.getTime() - new Date(lastSeen).getTime()) / DAY_MS);
            if (daysAway < settings.absence_nudge_days)
                continue;
            const lastNudge = await notificationModel.lastForMember(member.id, 'absence_nudge');
            if (lastNudge && now.getTime() - new Date(lastNudge.sent_at).getTime() < NUDGE_DEDUPE_MS)
                continue;
            const rotation = await notificationModel.countForMember(member.id, 'absence_nudge');
            await notifier.sendToMember(gym.id, member, 'absence_nudge', templates.absenceNudge(rotation, member.full_name, daysAway, gym.name), { days_away: daysAway });
        }
    }
}
/**
 * Runs every 10 minutes; when a gym passes its closing time and no summary
 * was sent today, the owner gets check-ins, revenue marked today, and
 * tomorrow's expiring members.
 */
async function runClosingSummaries(now = new Date()) {
    let sent = false;
    for (const gym of await gymModel.listAll()) {
        if (!botManager.getBot(gym.id))
            continue;
        const settings = gymModel.getSettings(gym);
        const [h, m] = settings.closing_time.split(':').map(Number);
        const closing = new Date(now);
        closing.setHours(h ?? 22, m ?? 0, 0, 0);
        if (now < closing)
            continue;
        if (await notificationModel.sentToGymToday(gym.id, 'admin_summary', now))
            continue;
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const tomorrow = (0, dates_1.dateOnly)(new Date(now.getTime() + DAY_MS));
        const [checkIns, revenue, expiring] = await Promise.all([
            checkInModel.countToday(gym.id, now),
            paymentModel.revenueSince(gym.id, startOfDay),
            (0, knex_1.db)('subscriptions as s')
                .join('members as m', 'm.id', 's.member_id')
                .where('s.gym_id', gym.id)
                .whereNot('s.status', 'frozen')
                .where('s.expires_at', tomorrow)
                .select('m.full_name'),
        ]);
        await notifier.sendToOwners(gym.id, 'admin_summary', templates.dailySummary({
            gymName: gym.name,
            checkIns,
            revenue,
            expiringTomorrow: expiring.map((e) => e.full_name),
        }), { check_ins: checkIns, revenue });
        sent = true;
    }
    return sent;
}
/**
 * Called after each unknown-face event: alert the owner once per day when an
 * unrecognized face has shown up 3+ times.
 */
async function maybeAlertUnknownFace(gymId, now = new Date()) {
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const row = await (0, knex_1.db)('events')
        .where({ gym_id: gymId, type: 'unknown_face' })
        .where('created_at', '>=', startOfDay)
        .count('id as count')
        .first();
    const count = Number(row?.count ?? 0);
    if (count < 3)
        return;
    if (await notificationModel.sentToGymToday(gymId, 'admin_alert', now))
        return;
    const gym = await gymModel.findById(gymId);
    if (!gym)
        return;
    await notifier.sendToOwners(gymId, 'admin_alert', templates.unknownFaceAlert(count, gym.name), {
        unknown_count: count,
    });
}
/** Telegram receipt after a marked payment (fire-and-forget from renew). */
async function sendReceipt(input) {
    const member = await memberModel.findById(input.gymId, input.memberId);
    if (!member)
        return;
    await notifier.sendToMember(input.gymId, member, 'receipt', templates.receipt(member.full_name, String(Number(input.amount)), input.planName, input.expiresAt, input.gymName), { amount: Number(input.amount), plan: input.planName });
}
//# sourceMappingURL=notificationService.js.map