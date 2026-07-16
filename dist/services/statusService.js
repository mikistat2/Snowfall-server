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
exports.recomputeMemberStatus = recomputeMemberStatus;
exports.recomputeGymStatuses = recomputeGymStatuses;
exports.recomputeAllGyms = recomputeAllGyms;
const knex_1 = require("../db/knex");
const gymModel = __importStar(require("../models/gymModel"));
const subscriptionModel = __importStar(require("../models/subscriptionModel"));
const memberModel = __importStar(require("../models/memberModel"));
const decisionEngine_1 = require("./decisionEngine");
const dates_1 = require("../utils/dates");
/** Recompute one member's status from their latest subscription. */
async function recomputeMemberStatus(memberId, settings, trx = knex_1.db) {
    const sub = await subscriptionModel.findLatestByMember(memberId, trx);
    const frozen = sub?.status === 'frozen';
    const daysLeft = sub ? (0, dates_1.daysBetween)((0, dates_1.dateOnly)(new Date()), sub.expires_at) : null;
    const status = (0, decisionEngine_1.deriveStatus)(daysLeft, settings, frozen);
    await memberModel.setStatus(memberId, status, trx);
    if (sub && !frozen) {
        const subStatus = status === 'expired' ? 'expired' : 'active';
        if (sub.status !== subStatus)
            await subscriptionModel.update(sub.id, { status: subStatus }, trx);
    }
    return status;
}
/** Daily recompute for every member of a gym (00:05 cron + on demand). */
async function recomputeGymStatuses(gymId) {
    const gym = await gymModel.findById(gymId);
    if (!gym)
        return { updated: 0 };
    const settings = gymModel.getSettings(gym);
    const today = (0, dates_1.dateOnly)(new Date());
    const rows = await subscriptionModel.listLatestForGym(gymId);
    let updated = 0;
    for (const row of rows) {
        const frozen = row.sub_status === 'frozen';
        const status = (0, decisionEngine_1.deriveStatus)((0, dates_1.daysBetween)(today, row.expires_at), settings, frozen);
        if (status !== row.member_status) {
            await memberModel.setStatus(row.member_id, status);
            updated++;
        }
        if (!frozen) {
            const subStatus = status === 'expired' ? 'expired' : 'active';
            if (row.sub_status !== subStatus) {
                await subscriptionModel.update(row.subscription_id, { status: subStatus });
            }
        }
    }
    return { updated };
}
async function recomputeAllGyms() {
    const gyms = await gymModel.listAll();
    for (const gym of gyms) {
        await recomputeGymStatuses(gym.id);
    }
}
//# sourceMappingURL=statusService.js.map