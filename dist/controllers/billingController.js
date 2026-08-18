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
exports.checkout = checkout;
exports.history = history;
exports.verifyReference = verifyReference;
exports.verifyScreenshot = verifyScreenshot;
const billingService = __importStar(require("../services/billingService"));
const errors_1 = require("../utils/errors");
/**
 * Gym-facing billing: what to pay, and proof that it was paid.
 *
 * A REJECTED receipt is a 200, not an error. The per-check breakdown is the
 * whole point of the response and the page renders it either way; an HTTP
 * error status would send it down the client's failure path where only the
 * message survives. Real error statuses are reserved for things that are not
 * a receipt verdict: 409 replay, 422 unreadable QR / provider off, 503 not
 * configured.
 */
async function checkout(req, res) {
    res.json(await billingService.checkout(req.auth.gymId));
}
async function history(req, res) {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 10)));
    res.json(await billingService.historyFor(req.auth.gymId, limit));
}
async function verifyReference(req, res) {
    const { provider, reference, planId, cycle } = req.body;
    res.json(await billingService.submitReference(req.auth.gymId, provider, reference.trim(), planId, cycle));
}
async function verifyScreenshot(req, res) {
    const file = req.file;
    // Multer drops the body silently when the multipart envelope overruns its
    // limit, which otherwise surfaces as a baffling "no file was uploaded".
    if (!file)
        throw (0, errors_1.badRequest)('No screenshot was uploaded. Choose a PNG, JPG or WebP image up to 6 MB.');
    const provider = req.body.provider;
    const planId = Number(req.body.planId);
    const cycle = req.body.cycle;
    if (!['CBE', 'TELEBIRR'].includes(provider))
        throw (0, errors_1.badRequest)('Choose a payment method.');
    if (!Number.isInteger(planId) || planId <= 0)
        throw (0, errors_1.badRequest)('Choose a subscription plan.');
    if (!['MONTHLY', 'YEARLY'].includes(cycle))
        throw (0, errors_1.badRequest)('Choose monthly or yearly billing.');
    res.json(await billingService.submitScreenshot(req.auth.gymId, provider, file.buffer, planId, cycle));
}
//# sourceMappingURL=billingController.js.map