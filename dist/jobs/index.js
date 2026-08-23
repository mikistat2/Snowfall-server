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
const activity_1 = require("../utils/activity");
const knex_1 = require("../db/knex");
const database_1 = require("../config/database");
const statusService_1 = require("../services/statusService");
const checkInModel = __importStar(require("../models/checkInModel"));
const gymModel = __importStar(require("../models/gymModel"));
const occupancyService = __importStar(require("../services/occupancyService"));
const notificationService = __importStar(require("../services/notificationService"));
const guestModel = __importStar(require("../models/guestModel"));
const eventModel = __importStar(require("../models/eventModel"));
const auditLogModel = __importStar(require("../models/auditLogModel"));
const botManager = __importStar(require("../telegram/botManager"));
const platformAlert = __importStar(require("../services/platformAlertService"));
/**
 * Jobs:
 *  - 00:05 daily: recompute every member's status per gym.
 *  - every 15 min: auto-checkout open sessions older than each gym's
 *    auto_checkout_hours, and everything after closing time.
 *  - 09:00 daily: Telegram expiry reminders + absence nudges.
 *  - every 10 min: daily closing summary to owners (once, after closing time).
 * (Phase 3 adds guest descriptor purge.)
 */
/**
 * Safety net for the two periodic sweeps: even with no signal at all, each one
 * still makes a full authoritative pass this often, so a missed wake-up
 * self-heals rather than parking a sweep indefinitely. Six hours is far below
 * the shortest deadline either job serves (a same-day closing summary) and far
 * above the cadence at which idle wake-ups would cost real compute.
 */
const SWEEP_SAFETY_MS = 6 * 60 * 60 * 1000;
const checkoutSweep = (0, activity_1.createSweepGate)(SWEEP_SAFETY_MS);
const summarySweep = (0, activity_1.createSweepGate)(SWEEP_SAFETY_MS);
/**
 * Retention windows for the two append-only log tables, which together are
 * more than half of each gym's storage growth against the 0.5 GB free-tier
 * limit (Neon's was 0.5 GB; Supabase's is 500 MB — the same problem).
 *
 * Both windows sit far beyond what the UI can reach: the event feed serves the
 * newest 50 rows per gym and the audit page the newest 200, neither paginated.
 * Nothing displayable is deleted — this only stops the tables growing forever.
 */
const EVENT_RETENTION_DAYS = 90;
const AUDIT_RETENTION_DAYS = 365;
function startJobs() {
    if (database_1.dbAutosuspends)
        startDbKeepAlive();
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
        // Storage retention. Runs after the recompute, inside the same nightly
        // wake-up, so pruning never costs a compute start of its own.
        try {
            const events = await eventModel.purgeOlderThan(EVENT_RETENTION_DAYS);
            const audits = await auditLogModel.purgeOlderThan(AUDIT_RETENTION_DAYS);
            // eslint-disable-next-line no-console
            console.log(`[jobs] retention prune: ${events} events, ${audits} audit logs`);
        }
        catch (err) {
            // eslint-disable-next-line no-console
            console.error('[jobs] retention prune failed', err);
        }
    });
    node_cron_1.default.schedule('*/15 * * * *', async () => {
        if (!checkoutSweep.shouldRun())
            return;
        const token = checkoutSweep.start();
        try {
            checkoutSweep.finish(token, await autoCheckout());
        }
        catch (err) {
            // eslint-disable-next-line no-console
            console.error('[jobs] auto-checkout failed', err);
        }
    });
    node_cron_1.default.schedule('0 9 * * *', async () => {
        // Both passes deliver over Telegram and already skip any gym without a
        // running bot — but only after `gymModel.listAll()` has woken Postgres to
        // tell them which gyms those are. When no gym has a bot at all, that wake
        // is pure cost, so the in-memory check comes first.
        if (!botManager.hasAnyBot())
            return;
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
        // The summary is a Telegram message to owners; with no bot running there
        // is nobody to send it to, and the sweep's opening `listAll()` would wake
        // the compute every 10 minutes to establish that. Checked before the
        // sweep gate so it costs nothing.
        if (!botManager.hasAnyBot())
            return;
        if (!summarySweep.shouldRun())
            return;
        const token = summarySweep.start();
        try {
            summarySweep.finish(token, await notificationService.runClosingSummaries());
        }
        catch (err) {
            // eslint-disable-next-line no-console
            console.error('[jobs] closing summary failed', err);
        }
    });
    // 08:00 daily: subscription reminders on the 30/14/7/3/1/0-days-left ladder
    // — to the PLATFORM admin (all gyms, one digest) and, when the paywall is
    // on, to each gym OWNER so they can renew themselves before being locked out.
    node_cron_1.default.schedule('0 8 * * *', async () => {
        try {
            await platformAlert.runSubscriptionAlerts();
        }
        catch (err) {
            // eslint-disable-next-line no-console
            console.error('[jobs] platform subscription alerts failed', err);
        }
        try {
            await platformAlert.runOwnerRenewalReminders();
        }
        catch (err) {
            // eslint-disable-next-line no-console
            console.error('[jobs] owner renewal reminders failed', err);
        }
    });
}
/**
 * Keeps an autosuspending compute awake while the app is in use.
 *
 * Only started when `dbAutosuspends` says the provider has a compute to keep
 * awake (Neon). On Supabase the instance is already running and this is dead
 * weight, so `startJobs` skips it.
 *
 * UptimeRobot's ping hits /health, which answers without touching Postgres —
 * so it keeps Render awake while the database still went cold after a few idle
 * minutes, and the first staff member to load a page paid the wake-up. This
 * runs a real (trivial) query on a cadence below the autosuspend delay.
 *
 * It only fires while someone is actually using the API. A gym that closed an
 * hour ago stops being warmed, the compute suspends, and the monthly
 * compute-hour usage tracks real usage instead of a guessed opening schedule.
 */
function startDbKeepAlive() {
    node_cron_1.default.schedule(`*/${activity_1.KEEPALIVE_INTERVAL_MINUTES} * * * *`, async () => {
        if (!(0, activity_1.isRecentlyActive)())
            return;
        try {
            await knex_1.db.raw('SELECT 1');
        }
        catch (err) {
            // eslint-disable-next-line no-console
            console.error('[jobs] db keep-alive failed', err);
        }
    });
}
async function autoCheckout() {
    const gyms = await gymModel.listAll();
    const touched = new Set();
    const now = new Date();
    for (const gym of gyms) {
        const settings = gymModel.getSettings(gym);
        // sessions older than this gym's auto_checkout_hours
        const stale = await checkInModel.autoCheckoutStale(gym.id, settings.auto_checkout_hours);
        stale.forEach((r) => touched.add(r.gym_id));
        // everything still open after closing time — one statement, not one
        // round-trip per open session
        const [h, m] = settings.closing_time.split(':').map(Number);
        const closing = new Date(now);
        closing.setHours(h ?? 22, m ?? 0, 0, 0);
        if (now >= closing) {
            const closed = await checkInModel.autoCheckoutAllOpen(gym.id);
            if (closed > 0)
                touched.add(gym.id);
        }
    }
    for (const gymId of touched) {
        await occupancyService.resync(gymId);
    }
    return touched.size > 0;
}
//# sourceMappingURL=index.js.map