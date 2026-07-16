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
exports.sendToMember = sendToMember;
exports.sendToOwners = sendToOwners;
const botManager = __importStar(require("./botManager"));
const notificationModel = __importStar(require("../models/notificationModel"));
const userModel = __importStar(require("../models/userModel"));
/**
 * Every send attempt is logged in `notifications`:
 *   sent                — delivered to Telegram
 *   failed              — bot API rejected it (blocked bot, bad chat, …)
 *   skipped_no_chat_id  — member has not linked Telegram yet (surfaced in UI)
 * Gyms with no bot configured are skipped silently (nothing was attempted).
 */
async function sendToMember(gymId, member, type, text, extraPayload = {}) {
    const entry = botManager.getBot(gymId);
    if (!entry)
        return; // no bot configured for this gym
    if (!member.telegram_chat_id) {
        await notificationModel.create({
            gym_id: gymId,
            member_id: member.id,
            type,
            status: 'skipped_no_chat_id',
            payload: { text, ...extraPayload },
        });
        return;
    }
    try {
        await entry.bot.api.sendMessage(Number(member.telegram_chat_id), text);
        await notificationModel.create({
            gym_id: gymId,
            member_id: member.id,
            type,
            status: 'sent',
            payload: { text, ...extraPayload },
        });
    }
    catch (err) {
        await notificationModel.create({
            gym_id: gymId,
            member_id: member.id,
            type,
            status: 'failed',
            payload: { text, error: err instanceof Error ? err.message : String(err), ...extraPayload },
        });
    }
}
/** Admin alerts / summaries go to every linked owner chat of the gym. */
async function sendToOwners(gymId, type, text, extraPayload = {}) {
    const entry = botManager.getBot(gymId);
    if (!entry)
        return;
    const chatIds = await userModel.ownerChatIds(gymId);
    if (chatIds.length === 0) {
        await notificationModel.create({
            gym_id: gymId,
            type,
            status: 'skipped_no_chat_id',
            payload: { text, ...extraPayload },
        });
        return;
    }
    let anyFailed = null;
    for (const chatId of chatIds) {
        try {
            await entry.bot.api.sendMessage(chatId, text);
        }
        catch (err) {
            anyFailed = err instanceof Error ? err.message : String(err);
        }
    }
    await notificationModel.create({
        gym_id: gymId,
        type,
        status: anyFailed ? 'failed' : 'sent',
        payload: { text, ...(anyFailed ? { error: anyFailed } : {}), ...extraPayload },
    });
}
//# sourceMappingURL=notifier.js.map