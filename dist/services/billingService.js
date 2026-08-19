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
exports.reasonCodeFor = reasonCodeFor;
exports.hasAccess = hasAccess;
exports.readyProviders = readyProviders;
exports.checkout = checkout;
exports.historyFor = historyFor;
exports.submitReference = submitReference;
exports.submitScreenshot = submitScreenshot;
exports.recordManualPayment = recordManualPayment;
const node_crypto_1 = __importDefault(require("node:crypto"));
const knex_1 = require("../db/knex");
const env_1 = require("../config/env");
const billingModel = __importStar(require("../models/billingModel"));
const gymModel = __importStar(require("../models/gymModel"));
const verification = __importStar(require("./verificationService"));
const receiptQr = __importStar(require("./receiptQrService"));
const billingChecks_1 = require("./billingChecks");
const errors_1 = require("../utils/errors");
/**
 * Platform subscription billing: everything a gym does to pay us, and the
 * single implementation of "does this gym have access".
 */
// ------------------------------------------------------------- reason code --
/**
 * Ambiguous glyphs are removed — no 0/O, no 1/I/L — because gym owners read
 * this off a screen and type it into a banking app on a phone.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function mintCode() {
    const bytes = node_crypto_1.default.randomBytes(6);
    let code = '';
    for (const byte of bytes)
        code += CODE_ALPHABET.charAt(byte % CODE_ALPHABET.length);
    return code;
}
/**
 * The gym's payment code, minted once and stable for the life of the account.
 * The same code is used for the first payment and every renewal, so an owner
 * who pays a day late or renews next year still matches. Never rotate it.
 */
async function reasonCodeFor(gymId) {
    const gym = await gymModel.findById(gymId);
    if (!gym)
        throw (0, errors_1.notFound)('Gym not found');
    if (gym.payment_reason_code)
        return gym.payment_reason_code;
    // Collisions at 31^6 are vanishingly unlikely, but the column is UNIQUE, so
    // retry rather than ever hand back a duplicate.
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const code = mintCode();
        try {
            const [row] = await (0, knex_1.db)('gyms')
                .where({ id: gymId })
                .whereNull('payment_reason_code')
                .update({ payment_reason_code: code })
                .returning('payment_reason_code');
            if (row?.payment_reason_code)
                return row.payment_reason_code;
            // Another request won the race — read theirs.
            const fresh = await gymModel.findById(gymId);
            if (fresh?.payment_reason_code)
                return fresh.payment_reason_code;
        }
        catch (err) {
            if (!isUniqueViolation(err))
                throw err;
        }
    }
    throw new errors_1.AppError(500, 'Could not allocate a payment code. Please try again.');
}
function isUniqueViolation(err) {
    const code = err?.code;
    return code === '23505' || code === '23000';
}
// ------------------------------------------------------------- access rule --
/**
 * The single rule behind both the API middleware and the flag the client
 * guards on, so the two can never disagree.
 *
 * The platform panel authenticates on its own JWT and never passes through
 * this check, so there is no bootstrapping problem: the payment accounts can
 * always be configured even when every gym is locked out.
 */
function hasAccess(gym, settings, now = new Date()) {
    if (!settings.payments_required)
        return true;
    if (gym.comped)
        return true;
    if (!gym.subscription_ends_at)
        return false;
    const deadline = new Date(gym.subscription_ends_at);
    deadline.setDate(deadline.getDate() + settings.grace_days);
    return deadline.getTime() > now.getTime();
}
/**
 * Only offer a provider that is BOTH enabled AND has everything needed to
 * verify it. A bank enabled without an account number would happily accept
 * money into an account we cannot check.
 */
function readyProviders(settings) {
    const options = [];
    if (settings.cbe_enabled && settings.cbe_account_number?.trim()) {
        options.push({
            provider: 'CBE',
            label: 'Commercial Bank of Ethiopia',
            accountNumber: settings.cbe_account_number.trim(),
            accountName: settings.cbe_account_name,
        });
    }
    if (settings.telebirr_enabled && settings.telebirr_phone?.trim()) {
        options.push({
            provider: 'TELEBIRR',
            label: 'Telebirr',
            accountNumber: settings.telebirr_phone.trim(),
            accountName: settings.telebirr_account_name,
        });
    }
    return options;
}
async function checkout(gymId) {
    const [settings, gym, plans] = await Promise.all([
        billingModel.getSettings(),
        gymModel.findById(gymId),
        billingModel.listPlans(),
    ]);
    if (!gym)
        throw (0, errors_1.notFound)('Gym not found');
    const providers = readyProviders(settings);
    return {
        paymentsRequired: settings.payments_required,
        active: hasAccess(gym, settings),
        comped: gym.comped,
        isTrial: gym.is_trial,
        expiresAt: gym.subscription_ends_at,
        reasonCode: await reasonCodeFor(gymId),
        plans,
        currentPlanId: gym.billing_plan_id,
        currentCycle: gym.billing_cycle,
        currency: settings.currency,
        instructions: settings.instructions,
        providers,
        configured: providers.length > 0 && verification.isConfigured(),
        graceDays: settings.grace_days,
    };
}
async function historyFor(gymId, limit = 10) {
    return billingModel.listForGym(gymId, limit);
}
/**
 * Shared preflight: fail fast before anything is spent or written.
 *
 * Provider readiness is deliberately NOT checked here — see
 * `assertProviderReady`, which the screenshot path calls only after the QR has
 * had its say about which provider actually issued the receipt.
 */
async function prepare(gymId, planId, cycle) {
    const [settings, gym] = await Promise.all([billingModel.getSettings(), gymModel.findById(gymId)]);
    if (!gym)
        throw (0, errors_1.notFound)('Gym not found');
    if (!settings.payments_required) {
        throw (0, errors_1.badRequest)('Payments are switched off — your subscription does not need paying for.', 'PAYMENTS_OFF');
    }
    if (!verification.isConfigured()) {
        throw new errors_1.AppError(503, 'Receipt verification is not set up yet. Please contact support before sending any money.', 'VERIFY_NOT_CONFIGURED');
    }
    const plan = await billingModel.findPlan(planId);
    if (!plan || !plan.is_active)
        throw (0, errors_1.badRequest)('That subscription plan is no longer available.');
    return { gym, settings, plan, cycle, reasonCode: await reasonCodeFor(gymId) };
}
/** Refuse a provider we have no account configured for — we could not check it. */
function assertProviderReady(settings, provider) {
    if (readyProviders(settings).some((p) => p.provider === provider))
        return;
    const label = provider === 'CBE' ? 'CBE bank' : 'Telebirr';
    throw (0, errors_1.badRequest)(`We are not set up to accept ${label} payments right now. Choose another method.`);
}
/**
 * Replay guard. Runs BEFORE the provider is called: each verification costs a
 * paid credit and we already know the answer.
 *
 * This is a fast path, not the guarantee — the guarantee is the UNIQUE index
 * on `verified_reference`, which is what survives two concurrent requests.
 */
async function guardReferenceUnused(reference, gymId) {
    const existing = await billingModel.findByVerifiedReference(reference);
    if (!existing)
        return;
    throw (0, errors_1.conflict)(existing.gym_id === gymId
        ? 'That receipt has already been used to extend your subscription.'
        : 'That receipt has already been used to activate another account.');
}
async function submitReference(gymId, provider, reference, planId, cycle) {
    const ctx = await prepare(gymId, planId, cycle);
    assertProviderReady(ctx.settings, provider);
    await guardReferenceUnused(reference, gymId);
    return verifyAndRecord(ctx, { provider, reference, accountSuffix: null, source: 'MANUAL' });
}
async function submitScreenshot(gymId, provider, file, planId, cycle) {
    const ctx = await prepare(gymId, planId, cycle);
    const qr = await receiptQr.decode(file);
    // Nothing was verified and no credit was spent, so there is no attempt worth
    // keeping — 422 with an actionable message and no row written.
    if (!qr.ok || !qr.reference)
        throw (0, errors_1.badRequest)(qr.error ?? 'No QR code could be read in that screenshot.');
    // The QR is authoritative about which provider issued the receipt; the radio
    // button on the form is only a hint. Readiness is therefore checked against
    // the EFFECTIVE provider — checking the form's value first would reject a
    // perfectly good CBE receipt for the sole reason that the owner had left
    // "Telebirr" selected.
    const effectiveProvider = qr.provider ?? provider;
    assertProviderReady(ctx.settings, effectiveProvider);
    await guardReferenceUnused(qr.reference, gymId);
    return verifyAndRecord(ctx, {
        provider: effectiveProvider,
        reference: qr.reference,
        accountSuffix: qr.accountSuffix,
        source: 'IMAGE',
    });
}
async function verifyAndRecord(ctx, input) {
    const envelope = await verification.lookup({
        provider: input.provider,
        reference: input.reference,
        accountSuffix: input.accountSuffix,
    });
    const outcome = (0, billingChecks_1.runChecks)({
        receipt: envelope.receipt,
        receiptError: envelope.error,
        reasonCode: ctx.reasonCode,
        plan: ctx.plan,
        selectedCycle: ctx.cycle,
        provider: input.provider,
        settings: ctx.settings,
    });
    const receipt = envelope.receipt;
    const base = {
        gym_id: ctx.gym.id,
        billing_plan_id: ctx.plan?.id ?? null,
        provider: input.provider,
        source: input.source,
        reference: receipt?.reference ?? input.reference,
        reason_code: ctx.reasonCode,
        selected_cycle: ctx.cycle,
        amount: receipt?.amount ?? null,
        currency: receipt?.currency ?? ctx.settings.currency,
        expected_amount: ctx.plan ? (0, billingChecks_1.priceFor)(ctx.plan, ctx.cycle) : null,
        payer_name: receipt?.payerName ?? null,
        payer_account: receipt?.payerAccount ?? null,
        receiver_name: receipt?.receiverName ?? null,
        receiver_account: receipt?.receiverAccount ?? null,
        transaction_at: receipt?.date ?? null,
        failure_reason: outcome.failureReason,
        warnings: outcome.warnings.length ? outcome.warnings : null,
        checks: outcome.checks,
        raw_response: env_1.env.verification.storeRawResponse ? envelope.raw : null,
    };
    if (!outcome.passed || !outcome.grantedCycle) {
        const payment = await billingModel.createPayment({
            ...base,
            status: 'REJECTED',
            granted_cycle: null,
            verified_reference: null,
        });
        const gym = await gymModel.findById(ctx.gym.id);
        return {
            verified: false,
            payment,
            checks: outcome.checks,
            error: outcome.failureReason,
            paid: gym ? hasAccess(gym, ctx.settings) : false,
            expiresAt: gym?.subscription_ends_at ?? null,
        };
    }
    return activate(ctx, base, outcome.grantedCycle, receipt?.reference ?? input.reference, outcome.checks);
}
/**
 * Persisting a success is ONE transaction: the verified reference, the period
 * and the gym's new expiry are written together. That ordering matters — a
 * receipt that loses the race against the unique index never leaves a
 * subscription extended.
 */
async function activate(ctx, base, grantedCycle, verifiedReference, checks) {
    const { start, end } = (0, billingChecks_1.computePeriod)(ctx.gym.subscription_ends_at, grantedCycle);
    try {
        const payment = await knex_1.db.transaction(async (trx) => {
            const row = await billingModel.createPayment({
                ...base,
                status: 'VERIFIED',
                granted_cycle: grantedCycle,
                verified_reference: verifiedReference,
                period_start: start,
                period_end: end,
                verified_at: new Date(),
            }, trx);
            await trx('gyms').where({ id: ctx.gym.id }).update({
                subscription_ends_at: end,
                billing_plan_id: ctx.plan?.id ?? null,
                billing_cycle: grantedCycle,
                is_trial: false,
                // A gym that has now paid is active; approval was implicit in the money.
                status: ctx.gym.status === 'pending' ? 'active' : ctx.gym.status,
                approved_at: ctx.gym.approved_at ?? new Date(),
            });
            return row;
        });
        return {
            verified: true,
            payment,
            checks,
            error: null,
            paid: true,
            expiresAt: end.toISOString(),
        };
    }
    catch (err) {
        // Lost the race for this reference — a 409, never a 500.
        if (isUniqueViolation(err)) {
            throw (0, errors_1.conflict)('That receipt has already been used to activate an account.');
        }
        throw err;
    }
}
// ------------------------------------------------ admin / cash at the desk --
/**
 * Recorded by a platform admin for a gym that paid cash, by hand, or through
 * any channel we cannot verify. It runs the same renewal maths as a verified
 * payment so there is exactly one implementation of the expiry rule, and it
 * carries no `verified_reference` — an unverifiable payment must stay visibly
 * different from a bank-verified one.
 *
 * `startNow` starts the paid period today instead of stacking it on the time
 * that is left. That is what converting a free trial means: the unused trial
 * days were never paid for, so they are not added on top of the month bought.
 */
async function recordManualPayment(input) {
    const [settings, gym] = await Promise.all([billingModel.getSettings(), gymModel.findById(input.gymId)]);
    if (!gym)
        throw (0, errors_1.notFound)('Gym not found');
    const plan = input.planId ? await billingModel.findPlan(input.planId) : null;
    const { start, end } = (0, billingChecks_1.computePeriod)(input.startNow ? null : gym.subscription_ends_at, input.cycle);
    const wasTrial = gym.is_trial;
    const payment = await knex_1.db.transaction(async (trx) => {
        const row = await billingModel.createPayment({
            gym_id: gym.id,
            billing_plan_id: plan?.id ?? null,
            provider: input.provider,
            source: 'ADMIN',
            status: 'VERIFIED',
            reason_code: gym.payment_reason_code,
            selected_cycle: input.cycle,
            granted_cycle: input.cycle,
            amount: input.amount,
            currency: settings.currency,
            expected_amount: plan ? (0, billingChecks_1.priceFor)(plan, input.cycle) : null,
            period_start: start,
            period_end: end,
            recorded_by: input.recordedBy,
            note: input.note,
            verified_at: new Date(),
            warnings: [
                'Recorded by a platform admin — not verified against a bank receipt.',
                ...(wasTrial ? ['Converted this gym from its free trial to a paid subscription.'] : []),
            ],
        }, trx);
        await trx('gyms').where({ id: gym.id }).update({
            subscription_ends_at: end,
            billing_plan_id: plan?.id ?? gym.billing_plan_id,
            billing_cycle: input.cycle,
            is_trial: false,
            status: gym.status === 'pending' ? 'active' : gym.status,
            approved_at: gym.approved_at ?? new Date(),
        });
        return row;
    });
    return {
        payment,
        expiresAt: end.toISOString(),
        startsAt: start.toISOString(),
        convertedFromTrial: wasTrial,
    };
}
//# sourceMappingURL=billingService.js.map