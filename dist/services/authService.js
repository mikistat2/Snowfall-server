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
exports.registerGym = registerGym;
exports.login = login;
exports.refresh = refresh;
exports.logout = logout;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const knex_1 = require("../db/knex");
const gymModel = __importStar(require("../models/gymModel"));
const userModel = __importStar(require("../models/userModel"));
const refreshTokenModel = __importStar(require("../models/refreshTokenModel"));
const platformModel = __importStar(require("../models/platformModel"));
const billingModel = __importStar(require("../models/billingModel"));
const platformAlert = __importStar(require("./platformAlertService"));
const jwt_1 = require("../utils/jwt");
const errors_1 = require("../utils/errors");
/**
 * What a gym is allowed to use before it has paid for anything.
 *
 * Telegram but not the camera — the "Regular + Telegram" package. The camera
 * is not a switch we can honestly flip on signup: it needs an on-site install
 * and carries a setup fee, so a trial that turned it on would be advertising
 * something nobody can actually use that day. Telegram costs nothing to grant
 * and is the half of the product a gym can try on its own.
 *
 * The package they CHOSE is still recorded on the gym, so the panel shows what
 * they came for and a verified payment grants the rest (see billingService's
 * grantsFor, which is grant-only and will only ever add to this).
 *
 * Applies to gyms created from here on. Existing gyms keep both features —
 * they were created under a `DEFAULT true` and nothing here touches them.
 */
const UNPAID_ENTITLEMENTS = { camera_allowed: false, telegram_allowed: true };
async function registerGym(input) {
    const existing = await userModel.findByEmail(input.owner.email);
    if (existing)
        throw (0, errors_1.conflict)('An account with this email already exists');
    const billing = await billingModel.getSettings();
    const paymentsDisabled = !billing.payments_required;
    /**
     * With the paywall off we are not selling packages, so a package id in the
     * request is ignored rather than honoured. The signup form does not offer
     * one — but an Android build installed before it stopped offering them still
     * will, and recording that gym against a package it was never charged for
     * would put a plan name in the platform panel that means nothing.
     *
     * Ignored, not rejected: their registration must still succeed.
     */
    const plan = paymentsDisabled || !input.planId ? null : ((await billingModel.findPlan(input.planId)) ?? null);
    // Checked rather than trusted: the id arrives from an unauthenticated form,
    // and a retired plan must not be signed up for just because a stale tab
    // still offers it.
    if (!paymentsDisabled && input.planId && (!plan || !plan.is_active)) {
        throw (0, errors_1.badRequest)('That package is no longer available. Please pick another.');
    }
    const passwordHash = await bcryptjs_1.default.hash(input.owner.password, 10);
    // Approval controls whether the gym waits in pending. Trial mode independently
    // decides whether an active gym starts with a limited free-trial period.
    const platform = await platformModel.getSettings();
    const registeredAt = new Date();
    const trialFields = {
        status: platform.approval_required ? 'pending' : 'active',
        is_trial: platform.trial_mode,
        ...(!platform.approval_required ? { approved_at: registeredAt } : {}),
        ...(platform.trial_mode && !platform.approval_required
            ? { subscription_ends_at: new Date(registeredAt.getTime() + platform.trial_days * 86_400_000) }
            : {}),
    };
    const { gym, user } = await knex_1.db.transaction(async (trx) => {
        const gym = await gymModel.create({
            ...input.gym,
            ...trialFields,
            comped: false,
            billing_plan_id: plan?.id ?? null,
            // Only meaningful alongside a plan — a cycle with nothing to bill is
            // not an intention, it is a stray field.
            //
            // Yearly is the fallback, matching what the signup form now selects.
            // It is only reached when a client sends a plan and no cycle at all,
            // which today means an old build; defaulting those to monthly while
            // every current screen shows yearly would record the wrong intent for
            // exactly the gyms whose choice we cannot see.
            billing_cycle: plan ? (input.cycle ?? 'YEARLY') : null,
            ...UNPAID_ENTITLEMENTS,
        }, trx);
        const user = await userModel.create({
            gym_id: gym.id,
            name: input.owner.name,
            email: input.owner.email,
            phone: input.owner.phone ?? null,
            password_hash: passwordHash,
            role: 'owner',
        }, trx);
        return { gym, user };
    });
    // tell the platform admin (best effort, never blocks registration)
    void platformAlert
        .notifyPlatformAdmin(platform.approval_required
        ? `New gym awaiting approval: ${gym.name}`
        : platform.trial_mode
            ? `New gym on FREE TRIAL: ${gym.name}`
            : `New gym activated without a free trial: ${gym.name}`, `Gym: ${gym.name}\nOwner: ${user.name} <${user.email}>\nPhone: ${input.gym.phone ?? input.owner.phone ?? '-'}\n\n` +
        (platform.approval_required
            ? `Approval is required.${platform.trial_mode ? ` A ${platform.trial_days}-day trial will start when approved.` : ''} Open your platform panel to approve or reject this registration.`
            : platform.trial_mode
                ? `Registered on a ${platform.trial_days}-day free trial. No approval is needed.`
                : 'The gym was activated immediately without a free trial.'))
        .catch(() => undefined);
    if (gym.status === 'pending') {
        return { pending: true, gym: { id: gym.id, name: gym.name } };
    }
    return issueTokens({ sub: user.id, gymId: gym.id, role: 'owner', name: user.name }, {
        user: { id: user.id, name: user.name, email: user.email, role: user.role, gym_id: gym.id },
        gym: { id: gym.id, name: gym.name },
    });
}
async function login(email, password) {
    const user = await userModel.findByEmail(email);
    if (!user || !(await bcryptjs_1.default.compare(password, user.password_hash))) {
        throw (0, errors_1.unauthorized)('Invalid email or password');
    }
    const gym = await gymModel.findById(user.gym_id);
    if (!gym)
        throw (0, errors_1.unauthorized)('Gym not found');
    if (gym.status === 'frozen') {
        throw (0, errors_1.forbidden)(gymModel.frozenMessage(gym), 'GYM_FROZEN');
    }
    if (gym.status === 'pending') {
        throw (0, errors_1.forbidden)('Your registration is still awaiting approval by the platform admin. You will be notified by email once it is approved.', 'GYM_PENDING');
    }
    return issueTokens({ sub: user.id, gymId: gym.id, role: user.role, name: user.name }, {
        user: { id: user.id, name: user.name, email: user.email, role: user.role, gym_id: gym.id },
        gym: { id: gym.id, name: gym.name },
    });
}
/** Rotate: verify + revoke the old refresh token, issue a fresh pair. */
async function refresh(refreshToken) {
    const hash = (0, jwt_1.hashRefreshToken)(refreshToken);
    const stored = await refreshTokenModel.findValid(hash);
    if (!stored)
        throw (0, errors_1.unauthorized)('Invalid refresh token');
    const user = await userModel.findById(stored.user_id);
    if (!user)
        throw (0, errors_1.unauthorized)('User no longer exists');
    const gym = await gymModel.findById(user.gym_id);
    if (!gym)
        throw (0, errors_1.unauthorized)('Gym not found');
    if (gym.status === 'frozen') {
        throw (0, errors_1.forbidden)(gymModel.frozenMessage(gym), 'GYM_FROZEN');
    }
    if (gym.status === 'pending') {
        throw (0, errors_1.forbidden)('Your registration is still awaiting approval by the platform admin. You will be notified by email once it is approved.', 'GYM_PENDING');
    }
    await refreshTokenModel.revoke(hash);
    return issueTokens({ sub: user.id, gymId: gym.id, role: user.role, name: user.name }, {
        user: { id: user.id, name: user.name, email: user.email, role: user.role, gym_id: gym.id },
        gym: { id: gym.id, name: gym.name },
    });
}
async function logout(refreshToken) {
    await refreshTokenModel.revoke((0, jwt_1.hashRefreshToken)(refreshToken));
}
async function issueTokens(payload, identity) {
    const accessToken = (0, jwt_1.signAccessToken)(payload);
    const { token, hash, expiresAt } = (0, jwt_1.generateRefreshToken)();
    await refreshTokenModel.create(payload.sub, hash, expiresAt);
    return { accessToken, refreshToken: token, ...identity };
}
//# sourceMappingURL=authService.js.map