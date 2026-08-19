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
exports.getSettings = getSettings;
exports.updateSettings = updateSettings;
exports.listPlans = listPlans;
exports.createPlan = createPlan;
exports.updatePlan = updatePlan;
exports.removePlan = removePlan;
exports.listAttempts = listAttempts;
exports.recordPayment = recordPayment;
exports.setComped = setComped;
exports.verificationStatus = verificationStatus;
const env_1 = require("../config/env");
const billingModel = __importStar(require("../models/billingModel"));
const billingService = __importStar(require("../services/billingService"));
const verification = __importStar(require("../services/verificationService"));
const gymModel = __importStar(require("../models/gymModel"));
const platformAlert = __importStar(require("../services/platformAlertService"));
const errors_1 = require("../utils/errors");
/**
 * Platform-owner control over subscription billing: the master switch, the
 * prices, our own payment accounts, and every verification attempt any gym has
 * ever made.
 *
 * The verification API key is NEVER sent to the browser — the panel is told
 * only whether one is present.
 */
async function getSettings(_req, res) {
    const settings = await billingModel.getSettings();
    res.json({
        ...settings,
        verificationConfigured: verification.isConfigured(),
        verificationEnvVar: 'VERIFY_API_KEY',
        /** Mirrors the server-side matcher so the admin sees what the bank is asked to match. */
        cbeAccountSuffix: (settings.cbe_account_number ?? '').replace(/\D/g, '').slice(-8) || null,
    });
}
async function updateSettings(req, res) {
    const patch = req.body;
    const updated = await billingModel.updateSettings(patch);
    res.json({
        ...updated,
        verificationConfigured: verification.isConfigured(),
        verificationEnvVar: 'VERIFY_API_KEY',
        cbeAccountSuffix: (updated.cbe_account_number ?? '').replace(/\D/g, '').slice(-8) || null,
    });
}
// ---------------------------------------------------------------- plans ----
async function listPlans(_req, res) {
    res.json(await billingModel.listPlans(true));
}
async function createPlan(req, res) {
    res.status(201).json(await billingModel.createPlan(req.body));
}
async function updatePlan(req, res) {
    const plan = await billingModel.updatePlan(Number(req.params.id), req.body);
    if (!plan)
        throw (0, errors_1.notFound)('Plan not found');
    res.json(plan);
}
/**
 * A plan with payments against it is never deleted — historic rows must keep
 * pointing at what was actually sold. Deactivate it instead.
 */
async function removePlan(req, res) {
    const id = Number(req.params.id);
    const usage = await billingModel.planUsage(id);
    if (usage > 0) {
        throw (0, errors_1.conflict)(`This plan has ${usage} payment${usage === 1 ? '' : 's'} recorded against it, so it cannot be deleted — ` +
            `the history must keep pointing at what was sold. Switch it off instead and it disappears from the ` +
            `billing page.`);
    }
    await billingModel.deletePlan(id);
    res.json({ ok: true });
}
// ------------------------------------------------------------- attempts ----
async function listAttempts(req, res) {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 25)));
    const status = req.query.status;
    const { rows, total } = await billingModel.listAll({
        search: req.query.search,
        status: status && ['PENDING', 'VERIFIED', 'REJECTED'].includes(status) ? status : undefined,
        page,
        pageSize,
    });
    res.json({
        data: rows,
        meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    });
}
// ------------------------------------------------- manual / cash payment ----
async function recordPayment(req, res) {
    const gymId = Number(req.params.id);
    const gym = await gymModel.findById(gymId);
    if (!gym)
        throw (0, errors_1.notFound)('Gym not found');
    const { planId, cycle, amount, provider, note, startNow } = req.body;
    if (!note?.trim())
        throw (0, errors_1.badRequest)('A note is required — record how and when this payment was received.');
    // Converting a free trial starts the paid period today by default: the days
    // left on a trial were never paid for, so they are not stacked on top of the
    // month or year being bought. An explicit `startNow` always wins.
    const result = await billingService.recordManualPayment({
        gymId,
        planId: planId ?? null,
        cycle,
        amount,
        provider,
        note: note.trim(),
        recordedBy: req.platform?.name ?? 'platform admin',
        startNow: startNow ?? gym.is_trial,
    });
    void platformAlert
        .notifyGymOwners(gymId, gym.name, 'renew', new Date(result.expiresAt).toDateString())
        .catch(() => undefined);
    res.json(result);
}
/**
 * Grant or revoke a permanent exemption from the paywall. Used for gyms that
 * joined while payments were switched off, and for anyone we choose to
 * grandfather by hand.
 */
async function setComped(req, res) {
    const gymId = Number(req.params.id);
    const { comped } = req.body;
    const gym = await gymModel.findById(gymId);
    if (!gym)
        throw (0, errors_1.notFound)('Gym not found');
    await gymModel.setComped(gymId, comped);
    res.json({ ok: true, comped });
}
/** Whether the verification key is present — used for the admin warning banner. */
function verificationStatus(_req, res) {
    res.json({
        configured: verification.isConfigured(),
        envVar: 'VERIFY_API_KEY',
        baseUrl: env_1.env.verification.baseUrl,
    });
}
//# sourceMappingURL=platformBillingController.js.map