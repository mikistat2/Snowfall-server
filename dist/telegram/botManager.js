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
function getBot(gymId) {
    return bots.get(gymId);
}
function getStatus(gymId) {
    const entry = bots.get(gymId);
    return {
        configured: entry !== undefined || startErrors.has(gymId),
        running: entry !== undefined,
        username: entry?.username ?? null,
        error: startErrors.get(gymId) ?? null,
    };
}
async function startBotForGym(gymId, token, gymName) {
    await stopBot(gymId);
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
        // long polling runs until stop(); don't await
        void bot.start({ drop_pending_updates: true }).catch((err) => {
            // eslint-disable-next-line no-console
            console.error(`[telegram] gym ${gymId} polling stopped:`, err.message);
            bots.delete(gymId);
            startErrors.set(gymId, err.message);
        });
        // eslint-disable-next-line no-console
        console.log(`[telegram] gym ${gymId} bot @${me.username} started`);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'invalid token';
        startErrors.set(gymId, message);
        // eslint-disable-next-line no-console
        console.error(`[telegram] gym ${gymId} bot failed to start: ${message}`);
    }
}
async function stopBot(gymId) {
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
/** Called on settings save when the token changed. */
async function restartBot(gymId, token) {
    if (!token) {
        startErrors.delete(gymId);
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