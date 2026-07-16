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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startJobs = startJobs;
exports.autoCheckout = autoCheckout;
const node_cron_1 = __importDefault(require("node-cron"));
const statusService_1 = require("../services/statusService");
const checkInModel = __importStar(require("../models/checkInModel"));
const gymModel = __importStar(require("../models/gymModel"));
const occupancyService = __importStar(require("../services/occupancyService"));
const notificationService = __importStar(require("../services/notificationService"));
const guestModel = __importStar(require("../models/guestModel"));
/**
 * Jobs:
 *  - 00:05 daily: recompute every member's status per gym.
 *  - every 15 min: auto-checkout open sessions older than each gym's
 *    auto_checkout_hours, and everything after closing time.
 *  - 09:00 daily: Telegram expiry reminders + absence nudges.
 *  - every 10 min: daily closing summary to owners (once, after closing time).
 * (Phase 3 adds guest descriptor purge.)
 */
function startJobs() {
    node_cron_1.default.schedule('5 0 * * *', async () => {
        try {
            await (0, statusService_1.recomputeAllGyms)();
            const purged = await guestModel.purgeExpiredDescriptors();
            // eslint-disable-next-line no-console
            console.log(`[jobs] daily status recompute done, purged ${purged} expired guest descriptors`);
        }
        catch (err) {
            // eslint-disable-next-line no-console
            console.error('[jobs] status recompute failed', err);
        }
    });
    node_cron_1.default.schedule('*/15 * * * *', async () => {
        try {
            await autoCheckout();
        }
        catch (err) {
            // eslint-disable-next-line no-console
            console.error('[jobs] auto-checkout failed', err);
        }
    });
    node_cron_1.default.schedule('0 9 * * *', async () => {
        try {
            await notificationService.runExpiryReminders();
            await notificationService.runAbsenceNudges();
            // eslint-disable-next-line no-console
            console.log('[jobs] 09:00 reminders + nudges done');
        }
        catch (err) {
            // eslint-disable-next-line no-console
            console.error('[jobs] reminders failed', err);
        }
    });
    node_cron_1.default.schedule('*/10 * * * *', async () => {
        try {
            await notificationService.runClosingSummaries();
        }
        catch (err) {
            // eslint-disable-next-line no-console
            console.error('[jobs] closing summary failed', err);
        }
    });
}
async function autoCheckout() {
    const gyms = await gymModel.listAll();
    const touched = new Set();
    const now = new Date();
    for (const gym of gyms) {
        const settings = gymModel.getSettings(gym);
        // sessions older than auto_checkout_hours
        const stale = await checkInModel.autoCheckoutStale(settings.auto_checkout_hours);
        stale.forEach((r) => touched.add(r.gym_id));
        // everything still open after closing time
        const [h, m] = settings.closing_time.split(':').map(Number);
        const closing = new Date(now);
        closing.setHours(h ?? 22, m ?? 0, 0, 0);
        if (now >= closing) {
            const open = await checkInModel.listOpen(gym.id);
            for (const session of open) {
                await checkInModel.checkout(session.id, 'auto');
                touched.add(gym.id);
            }
        }
    }
    for (const gymId of touched) {
        await occupancyService.resync(gymId);
    }
}
//# sourceMappingURL=index.js.map