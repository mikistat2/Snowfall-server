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
async function registerGym(input) {
    const existing = await userModel.findByEmail(input.owner.email);
    if (existing)
        throw (0, errors_1.conflict)('An account with this email already exists');
    const passwordHash = await bcryptjs_1.default.hash(input.owner.password, 10);
    // Free-trial mode (set by the platform admin): the gym starts immediately
    // on a limited trial. Otherwise it waits as 'pending' until approved.
    const platform = await platformModel.getSettings();
    const trialFields = platform.trial_mode
        ? {
            status: 'active',
            is_trial: true,
            approved_at: new Date(),
            subscription_ends_at: new Date(Date.now() + platform.trial_days * 86_400_000),
        }
        : { status: 'pending' };
    /**
     * Stamped at registration, never evaluated retroactively: a gym that signs
     * up while the paywall is OFF keeps its access forever, even after the
     * switch is turned back on. Turning payments on must only affect people who
     * sign up afterwards — otherwise a free launch turns into a mass lockout the
     * day you start charging.
     */
    const billing = await billingModel.getSettings();
    const comped = !billing.payments_required;
    const { gym, user } = await knex_1.db.transaction(async (trx) => {
        const gym = await gymModel.create({ ...input.gym, ...trialFields, comped }, trx);
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
        .notifyPlatformAdmin(platform.trial_mode
        ? `New gym on FREE TRIAL: ${gym.name}`
        : `New gym awaiting approval: ${gym.name}`, `Gym: ${gym.name}\nOwner: ${user.name} <${user.email}>\nPhone: ${input.gym.phone ?? input.owner.phone ?? '-'}\n\n` +
        (platform.trial_mode
            ? `Registered on a ${platform.trial_days}-day free trial (trial mode is ON). No action needed.`
            : `Open your platform panel to approve or reject this registration.`))
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
        throw (0, errors_1.forbidden)('This gym account has been frozen by the platform. Please contact support.', 'GYM_FROZEN');
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
        throw (0, errors_1.forbidden)('This gym account has been frozen by the platform. Please contact support.', 'GYM_FROZEN');
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