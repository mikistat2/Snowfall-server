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
exports.freeze = freeze;
exports.unfreeze = unfreeze;
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