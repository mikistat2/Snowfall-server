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
exports.renew = renew;
const knex_1 = require("../db/knex");
const gymModel = __importStar(require("../models/gymModel"));
const memberModel = __importStar(require("../models/memberModel"));
const planModel = __importStar(require("../models/planModel"));
const subscriptionModel = __importStar(require("../models/subscriptionModel"));
const paymentModel = __importStar(require("../models/paymentModel"));
const eventModel = __importStar(require("../models/eventModel"));
const auditLogModel = __importStar(require("../models/auditLogModel"));
const decisionEngine_1 = require("./decisionEngine");
const statusService_1 = require("./statusService");
const sockets_1 = require("../sockets");
const errors_1 = require("../utils/errors");
/**
 * Renewal: new expiry = max(today, current expiry) + plan.duration_days.
 * Same plan → extend the existing subscription; different plan → new
 * subscription row (keeps plan history readable). Payment row is immutable.
 */
async function renew(input) {
    const gym = await gymModel.findById(input.gymId);
    if (!gym)
        throw (0, errors_1.notFound)('Gym not found');
    const settings = gymModel.getSettings(gym);
    const result = await knex_1.db.transaction(async (trx) => {
        const member = await memberModel.findById(input.gymId, input.memberId, trx);
        if (!member)
            throw (0, errors_1.notFound)('Member not found');
        if (member.archived_at)
            throw (0, errors_1.badRequest)('This member is archived — restore them before taking payment');
        const plan = await planModel.findById(input.gymId, input.planId);
        if (!plan)
            throw (0, errors_1.notFound)('Plan not found');
        const current = await subscriptionModel.findLatestByMember(input.memberId, trx);
        const { startsAt, expiresAt } = (0, decisionEngine_1.computeRenewal)(current?.expires_at ?? null, new Date(), plan.duration_days);
        let subscriptionId;
        if (current && current.plan_id === plan.id) {
            await subscriptionModel.update(current.id, { expires_at: expiresAt, status: 'active', frozen_at: null, frozen_days_remaining: null }, trx);
            subscriptionId = current.id;
        }
        else {
            const created = await subscriptionModel.create({
                gym_id: input.gymId,
                member_id: input.memberId,
                plan_id: plan.id,
                starts_at: startsAt,
                expires_at: expiresAt,
            }, trx);
            subscriptionId = created.id;
        }
        const payment = await paymentModel.create({
            gym_id: input.gymId,
            member_id: input.memberId,
            subscription_id: subscriptionId,
            amount: input.amount ?? Number(plan.price),
            method: input.method,
            marked_by: input.userId,
            note: input.note ?? null,
        }, trx);
        const status = await (0, statusService_1.recomputeMemberStatus)(input.memberId, settings, trx);
        await auditLogModel.log({
            gym_id: input.gymId,
            user_id: input.userId,
            action: 'payment.marked',
            entity: 'payment',
            entity_id: payment.id,
            meta: { member_id: input.memberId, plan_id: plan.id, amount: payment.amount, method: input.method },
        }, trx);
        return { payment, member, plan, expiresAt, status };
    });
    const event = await eventModel.create({
        gym_id: input.gymId,
        type: 'payment',
        severity: 'green',
        message: `${result.member.full_name} — renewed ${result.plan.name} · valid until ${result.expiresAt}`,
        member_id: input.memberId,
    });
    (0, sockets_1.emitToGym)(input.gymId, 'event:new', event);
    // a just-renewed member must not ride a cached "denied" decision at the door
    const { clearDebounce } = await Promise.resolve().then(() => __importStar(require('./checkInService')));
    clearDebounce(input.gymId, input.memberId);
    // Telegram receipt (fire-and-forget; logged in notifications either way)
    void Promise.resolve().then(() => __importStar(require('./notificationService'))).then((s) => s
        .sendReceipt({
        gymId: input.gymId,
        memberId: input.memberId,
        amount: result.payment.amount,
        planName: result.plan.name,
        expiresAt: result.expiresAt,
        gymName: gym.name,
    })
        .catch(() => undefined));
    return { paymentId: result.payment.id, expiresAt: result.expiresAt, status: result.status };
}
//# sourceMappingURL=paymentService.js.map