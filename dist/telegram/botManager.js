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
exports.getBot = getBot;
exports.getStatus = getStatus;
exports.startBotForGym = startBotForGym;
exports.stopBot = stopBot;
exports.restartBot = restartBot;
exports.initBots = initBots;
const grammy_1 = require("grammy");
const gymModel = __importStar(require("../models/gymModel"));
const memberModel = __importStar(require("../models/memberModel"));
const userModel = __importStar(require("../models/userModel"));
const occupancyService = __importStar(require("../services/occupancyService"));
const templates = __importStar(require("./templates"));
const bots = new Map();
const startErrors = new Map();
const desired = new Map();
const retryTimers = new Map();
const retryAttempts = new Map();
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;
function getBot(gymId) {
    return bots.get(gymId);
}
function getStatus(gymId) {
    const entry = bots.get(gymId);
    return {
        configured: entry !== undefined || startErrors.has(gymId) || desired.has(gymId),
        running: entry !== undefined,
        username: entry?.username ?? null,
        error: startErrors.get(gymId) ?? null,
    };
}
/** Stop the live bot but keep the "desired" intent (so retries continue). */
async function stopRunning(gymId) {
    const entry = bots.get(gymId);
    if (!entry)
        return;
    bots.delete(gymId);
    try {
        await entry.bot.stop();
    }
    catch {
        /* already stopped */
    }
}
function cancelRetry(gymId) {
    const timer = retryTimers.get(gymId);
    if (timer) {
        clearTimeout(timer);
        retryTimers.delete(gymId);
    }
    retryAttempts.delete(gymId);
}
function scheduleRetry(gymId) {
    if (retryTimers.has(gymId))
        return; // one pending retry at a time
    const attempt = (retryAttempts.get(gymId) ?? 0) + 1;
    retryAttempts.set(gymId, attempt);
    const delay = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
    // eslint-disable-next-line no-console
    console.log(`[telegram] gym ${gymId} will reconnect in ${delay / 1000}s (attempt ${attempt})`);
    const timer = setTimeout(() => {
        retryTimers.delete(gymId);
        const want = desired.get(gymId);
        if (want)
            void startBotForGym(gymId, want.token, want.gymName);
    }, delay);
    retryTimers.set(gymId, timer);
}
function handleFailure(gymId, err) {
    const message = err instanceof Error ? err.message : String(err);
    bots.delete(gymId);
    startErrors.set(gymId, message);
    // A 401 means the token itself is wrong — retrying can never fix that.
    if (err instanceof grammy_1.GrammyError && err.error_code === 401) {
        // eslint-disable-next-line no-console
        console.error(`[telegram] gym ${gymId} invalid token — not retrying: ${message}`);
        cancelRetry(gymId);
        return;
    }
    // 409 (conflict) or a network blip — keep trying while this gym is desired.
    // eslint-disable-next-line no-console
    console.error(`[telegram] gym ${gymId} polling stopped: ${message}`);
    if (desired.has(gymId))
        scheduleRetry(gymId);
}
async function startBotForGym(gymId, token, gymName) {
    desired.set(gymId, { token, gymName }); // record intent BEFORE any await
    await stopRunning(gymId);
    startErrors.delete(gymId);
    const bot = new grammy_1.Bot(token);
    bot.command('start', async (ctx) => {
        const payload = (ctx.match ?? '').trim();
        const chatId = ctx.chat.id;
        if (payload.startsWith('m')) {
            const member = await memberModel.findByLinkToken(payload.slice(1));
            if (member && member.gym_id === gymId) {
                await memberModel.bindTelegram(member.id, chatId, ctx.from?.username ?? null);
                await ctx.reply(templates.linkedWelcome(member.full_name, gymName));
                return;
            }
        }
        else if (payload.startsWith('a')) {
            const user = await userModel.findByLinkToken(payload.slice(1));
            if (user && user.gym_id === gymId) {
                await userModel.bindTelegram(user.id, chatId);
                await ctx.reply(templates.adminLinkedWelcome(user.name, gymName));
                return;
            }
        }
        await ctx.reply(`👋 Welcome to ${gymName}! Ask the front desk for your personal link to connect your membership.`);
    });
    bot.command('traffic', async (ctx) => {
        const count = await occupancyService.getOccupancy(gymId);
        await ctx.reply(templates.trafficReply(count, templates.trafficLabel(count)));
    });
    bot.catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[telegram] gym ${gymId} bot error:`, err.message);
    });
    try {
        const me = await bot.api.getMe();
        bots.set(gymId, { bot, username: me.username, gymId });
        cancelRetry(gymId); // connected cleanly — reset backoff
        // long polling runs until stop(); don't await. On failure, retry.
        void bot.start({ drop_pending_updates: true }).catch((err) => {
            handleFailure(gymId, err);
        });
        // eslint-disable-next-line no-console
        console.log(`[telegram] gym ${gymId} bot @${me.username} started`);
    }
    catch (err) {
        handleFailure(gymId, err);
    }
}
/** External stop: clears intent and any pending retry, then stops the bot. */
async function stopBot(gymId) {
    desired.delete(gymId);
    startErrors.delete(gymId);
    cancelRetry(gymId);
    await stopRunning(gymId);
}
/** Called on settings save when the token changed. */
async function restartBot(gymId, token) {
    if (!token) {
        await stopBot(gymId);
        return;
    }
    const gym = await gymModel.findById(gymId);
    await startBotForGym(gymId, token, gym?.name ?? 'your gym');
}
/** Boot: start bots for every gym that has a token configured. */
async function initBots() {
    const gyms = await gymModel.listAll();
    for (const gym of gyms) {
        if (gym.telegram_bot_token) {
            await startBotForGym(gym.id, gym.telegram_bot_token, gym.name);
        }
    }
}
//# sourceMappingURL=botManager.js.map