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
exports.enroll = enroll;
exports.enrollPrevious = enrollPrevious;
exports.freeze = freeze;
exports.unfreeze = unfreeze;
exports.archive = archive;
exports.restore = restore;
exports.remove = remove;
exports.detail = detail;
const knex_1 = require("../db/knex");
const gymModel = __importStar(require("../models/gymModel"));
const memberModel = __importStar(require("../models/memberModel"));
const planModel = __importStar(require("../models/planModel"));
const subscriptionModel = __importStar(require("../models/subscriptionModel"));
const paymentModel = __importStar(require("../models/paymentModel"));
const auditLogModel = __importStar(require("../models/auditLogModel"));
const statusService_1 = require("./statusService");
const checkInService_1 = require("./checkInService");
const dates_1 = require("../utils/dates");
const ethiopian_1 = require("../utils/ethiopian");
const errors_1 = require("../utils/errors");
/**
 * Enrollment: member + face descriptors + first subscription + first payment,
 * all in one transaction so a half-enrolled member can never exist.
 */
async function enroll(input) {
    const gym = await gymModel.findById(input.gymId);
    if (!gym)
        throw (0, errors_1.notFound)('Gym not found');
    const settings = gymModel.getSettings(gym);
    if (input.descriptors.some((d) => d.length !== 128)) {
        throw (0, errors_1.badRequest)('Each face descriptor must have 128 values');
    }
    return knex_1.db.transaction(async (trx) => {
        const plan = await planModel.findById(input.gymId, input.planId);
        if (!plan || !plan.active)
            throw (0, errors_1.badRequest)('Plan not found or inactive');
        const member = await memberModel.create(input.gymId, input.member, trx);
        if (input.descriptors.length > 0) {
            await memberModel.addDescriptors(member.id, input.descriptors, trx);
        }
        const startsAt = (0, dates_1.dateOnly)(new Date());
        const subscription = await subscriptionModel.create({
            gym_id: input.gymId,
            member_id: member.id,
            plan_id: plan.id,
            starts_at: startsAt,
            expires_at: (0, dates_1.addDays)(startsAt, plan.duration_days),
        }, trx);
        await paymentModel.create({
            gym_id: input.gymId,
            member_id: member.id,
            subscription_id: subscription.id,
            amount: input.payment.amount ?? Number(plan.price),
            method: input.payment.method,
            marked_by: input.userId,
            note: input.payment.note ?? 'Enrollment',
        }, trx);
        const status = await (0, statusService_1.recomputeMemberStatus)(member.id, settings, trx);
        await auditLogModel.log({
            gym_id: input.gymId,
            user_id: input.userId,
            action: 'member.enrolled',
            entity: 'member',
            entity_id: member.id,
            meta: { plan_id: plan.id, descriptors: input.descriptors.length },
        }, trx);
        return { ...member, status };
    });
}
/**
 * Back-fill a member who was already training before the system was installed.
 *
 * Differences from `enroll`, all of them consequences of the record coming off
 * a paper register rather than from someone standing at the desk:
 *  - the dates are given, not "today" — and may be written in the Ethiopian
 *    calendar, so they are converted here before anything is stored;
 *  - the subscription period is the one already running (or already over), so
 *    an overdue paper member lands as `grace`/`expired` on the very first
 *    status recompute and is refused at the door until someone renews them;
 *  - the payment is historical and optional: it is stamped with the date it was
 *    actually taken, so back-filling a hundred members cannot fake a spike in
 *    this month's revenue;
 *  - face captures are optional, since the member is rarely present while their
 *    paper record is being typed in.
 */
async function enrollPrevious(input) {
    const gym = await gymModel.findById(input.gymId);
    if (!gym)
        throw (0, errors_1.notFound)('Gym not found');
    const settings = gymModel.getSettings(gym);
    if (input.descriptors.some((d) => d.length !== 128)) {
        throw (0, errors_1.badRequest)('Each face descriptor must have 128 values');
    }
    const convert = (value, field) => {
        const gregorian = (0, ethiopian_1.toGregorianDateOnly)(value, input.calendar);
        if (!gregorian)
            throw (0, errors_1.badRequest)(`${field} is not a valid ${input.calendar} date`);
        return gregorian;
    };
    const joinedAt = convert(input.joinedAt, 'Registration date');
    const startsAt = convert(input.startsAt, 'Membership start date');
    const expiresOverride = input.expiresAt ? convert(input.expiresAt, 'Expiry date') : undefined;
    // A paper record is history: a future join date means the calendar toggle was
    // wrong (Ethiopian years read ~8 ahead), which is worth catching loudly.
    const today = (0, dates_1.dateOnly)(new Date());
    if ((0, dates_1.daysBetween)(today, joinedAt) > 0)
        throw (0, errors_1.badRequest)('Registration date cannot be in the future');
    if ((0, dates_1.daysBetween)(joinedAt, startsAt) < 0) {
        throw (0, errors_1.badRequest)('Membership start date cannot be before the registration date');
    }
    if (expiresOverride && (0, dates_1.daysBetween)(startsAt, expiresOverride) < 0) {
        throw (0, errors_1.badRequest)('Expiry date cannot be before the membership start date');
    }
    return knex_1.db.transaction(async (trx) => {
        const plan = await planModel.findById(input.gymId, input.planId);
        if (!plan || !plan.active)
            throw (0, errors_1.badRequest)('Plan not found or inactive');
        const member = await memberModel.create(input.gymId, { ...input.member, joined_at: joinedAt }, trx);
        if (input.descriptors.length > 0) {
            await memberModel.addDescriptors(member.id, input.descriptors, trx);
        }
        const expiresAt = expiresOverride ?? (0, dates_1.addDays)(startsAt, plan.duration_days);
        const subscription = await subscriptionModel.create({
            gym_id: input.gymId,
            member_id: member.id,
            plan_id: plan.id,
            starts_at: startsAt,
            expires_at: expiresAt,
        }, trx);
        if (input.payment) {
            await paymentModel.create({
                gym_id: input.gymId,
                member_id: member.id,
                subscription_id: subscription.id,
                amount: input.payment.amount ?? Number(plan.price),
                method: input.payment.method,
                marked_by: input.userId,
                note: input.payment.note ?? 'Previous member (paper record)',
                created_at: startsAt,
            }, trx);
        }
        const status = await (0, statusService_1.recomputeMemberStatus)(member.id, settings, trx);
        await auditLogModel.log({
            gym_id: input.gymId,
            user_id: input.userId,
            action: 'member.enrolled_previous',
            entity: 'member',
            entity_id: member.id,
            meta: {
                plan_id: plan.id,
                descriptors: input.descriptors.length,
                calendar: input.calendar,
                entered_calendar: input.enteredCalendar ?? input.calendar,
                // what was typed off the paper, alongside what it was stored as
                entered: { joined_at: input.joinedAt, starts_at: input.startsAt, expires_at: input.expiresAt ?? null },
                stored: { joined_at: joinedAt, starts_at: startsAt, expires_at: expiresAt },
                payment_recorded: Boolean(input.payment),
            },
        }, trx);
        return { ...member, status };
    });
}
/** Freeze: remember how many days are left; expiry stops mattering until unfreeze. */
async function freeze(gymId, memberId, userId) {
    const member = await memberModel.findById(gymId, memberId);
    if (!member)
        throw (0, errors_1.notFound)('Member not found');
    const sub = await subscriptionModel.findLatestByMember(memberId);
    if (!sub)
        throw (0, errors_1.badRequest)('Member has no subscription to freeze');
    if (sub.status === 'frozen')
        throw (0, errors_1.badRequest)('Already frozen');
    const remaining = Math.max(0, (0, dates_1.daysBetween)((0, dates_1.dateOnly)(new Date()), sub.expires_at));
    await knex_1.db.transaction(async (trx) => {
        await subscriptionModel.update(sub.id, { status: 'frozen', frozen_at: new Date(), frozen_days_remaining: remaining }, trx);
        await memberModel.setStatus(memberId, 'frozen', trx);
        await auditLogModel.log({ gym_id: gymId, user_id: userId, action: 'member.frozen', entity: 'member', entity_id: memberId, meta: { remaining } }, trx);
    });
    (0, checkInService_1.clearDebounce)(gymId, memberId); // deny at the door immediately
}
/** Unfreeze: expiry = today + stored remaining days. */
async function unfreeze(gymId, memberId, userId) {
    const gym = await gymModel.findById(gymId);
    if (!gym)
        throw (0, errors_1.notFound)('Gym not found');
    const member = await memberModel.findById(gymId, memberId);
    if (!member)
        throw (0, errors_1.notFound)('Member not found');
    const sub = await subscriptionModel.findLatestByMember(memberId);
    if (!sub || sub.status !== 'frozen')
        throw (0, errors_1.badRequest)('Member is not frozen');
    const expiresAt = (0, dates_1.addDays)((0, dates_1.dateOnly)(new Date()), sub.frozen_days_remaining ?? 0);
    await knex_1.db.transaction(async (trx) => {
        await subscriptionModel.update(sub.id, { status: 'active', expires_at: expiresAt, frozen_at: null, frozen_days_remaining: null }, trx);
        await (0, statusService_1.recomputeMemberStatus)(memberId, gymModel.getSettings(gym), trx);
        await auditLogModel.log({ gym_id: gymId, user_id: userId, action: 'member.unfrozen', entity: 'member', entity_id: memberId, meta: { expiresAt } }, trx);
    });
    (0, checkInService_1.clearDebounce)(gymId, memberId); // allow at the door immediately
}
/**
 * Take a member off the roster without touching their money.
 *
 * They vanish from the members list, the door monitor's recognition cache, the
 * status cron and the reminder jobs, but every payment they ever made stays
 * exactly where it is — which is the only way to remove a paying member without
 * rewriting past revenue.
 */
async function archive(gymId, memberId, userId) {
    const member = await memberModel.findById(gymId, memberId);
    if (!member)
        throw (0, errors_1.notFound)('Member not found');
    if (member.archived_at)
        throw (0, errors_1.badRequest)('Member is already archived');
    const updated = await memberModel.setArchived(gymId, memberId, true);
    await auditLogModel.log({
        gym_id: gymId,
        user_id: userId,
        action: 'member.archived',
        entity: 'member',
        entity_id: memberId,
        meta: { full_name: member.full_name },
    });
    (0, checkInService_1.clearDebounce)(gymId, memberId); // deny at the door immediately
    return updated;
}
/** Put an archived member back on the roster, with their status recomputed. */
async function restore(gymId, memberId, userId) {
    const gym = await gymModel.findById(gymId);
    if (!gym)
        throw (0, errors_1.notFound)('Gym not found');
    const member = await memberModel.findById(gymId, memberId);
    if (!member)
        throw (0, errors_1.notFound)('Member not found');
    if (!member.archived_at)
        throw (0, errors_1.badRequest)('Member is not archived');
    const updated = await knex_1.db.transaction(async (trx) => {
        const row = await memberModel.setArchived(gymId, memberId, false, trx);
        // the nightly cron skipped them while archived, so their stored status is
        // as stale as the day they left
        await (0, statusService_1.recomputeMemberStatus)(memberId, gymModel.getSettings(gym), trx);
        return row;
    });
    await auditLogModel.log({
        gym_id: gymId,
        user_id: userId,
        action: 'member.restored',
        entity: 'member',
        entity_id: memberId,
        meta: { full_name: member.full_name },
    });
    (0, checkInService_1.clearDebounce)(gymId, memberId);
    return (await memberModel.findById(gymId, memberId)) ?? updated;
}
/**
 * Permanent deletion — only for a member with no payment history, which in
 * practice means a mistake: a duplicate or a mistyped row from back-filling the
 * paper register. Anyone who has ever paid must be archived instead, because
 * `payments` is an immutable audit trail and deleting from it would silently
 * change past revenue figures.
 */
async function remove(gymId, memberId, userId) {
    const member = await memberModel.findById(gymId, memberId);
    if (!member)
        throw (0, errors_1.notFound)('Member not found');
    const payments = await memberModel.paymentCount(memberId);
    if (payments > 0) {
        throw (0, errors_1.badRequest)(`This member has ${payments} recorded payment${payments === 1 ? '' : 's'}. ` +
            'Deleting them would change past income records — archive them instead.');
    }
    await knex_1.db.transaction(async (trx) => {
        await memberModel.hardDelete(gymId, memberId, trx);
        // the member row is gone, so the log keeps the name: entity_id alone would
        // point at nothing
        await auditLogModel.log({
            gym_id: gymId,
            user_id: userId,
            action: 'member.deleted',
            entity: 'member',
            entity_id: memberId,
            meta: { full_name: member.full_name, phone: member.phone, joined_at: member.joined_at },
        }, trx);
    });
    (0, checkInService_1.clearDebounce)(gymId, memberId);
}
/** Full member detail for the member page. */
async function detail(gymId, memberId) {
    const member = await memberModel.findById(gymId, memberId);
    if (!member)
        throw (0, errors_1.notFound)('Member not found');
    const [subscriptions, payments, checkIns, descriptors] = await Promise.all([
        subscriptionModel.listByMember(memberId),
        paymentModel.listByMember(memberId),
        Promise.resolve().then(() => __importStar(require('../models/checkInModel'))).then((m) => m.listRecentByMember(memberId)),
        memberModel.descriptorCount(memberId),
    ]);
    return { member, subscriptions, payments, check_ins: checkIns, descriptor_count: descriptors };
}
//# sourceMappingURL=memberService.js.map