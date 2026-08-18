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
exports.requireAuth = requireAuth;
exports.requireOwner = requireOwner;
exports.requirePlatformAdmin = requirePlatformAdmin;
exports.requirePlatformOwner = requirePlatformOwner;
exports.requirePlatformPerm = requirePlatformPerm;
exports.blockFrozenGym = blockFrozenGym;
exports.requireActiveSubscription = requireActiveSubscription;
const jwt_1 = require("../utils/jwt");
const errors_1 = require("../utils/errors");
const gymModel = __importStar(require("../models/gymModel"));
const billingModel = __importStar(require("../models/billingModel"));
const billingService = __importStar(require("../services/billingService"));
const platformAdminModel = __importStar(require("../models/platformAdminModel"));
function requireAuth(req, _res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer '))
        throw (0, errors_1.unauthorized)('Missing bearer token');
    req.auth = (0, jwt_1.verifyAccessToken)(header.slice(7));
    next();
}
function requireOwner(req, _res, next) {
    if (req.auth.role !== 'owner')
        throw (0, errors_1.forbidden)('Owner role required');
    next();
}
/**
 * Platform panel guard. The owner (sub 0) authenticates purely by token;
 * sub-admins are re-checked against platform_admins on every request, so
 * removing one (or editing their permissions) takes effect immediately.
 */
async function requirePlatformAdmin(req, _res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer '))
        throw (0, errors_1.unauthorized)('Missing bearer token');
    const payload = (0, jwt_1.verifyAccessToken)(header.slice(7));
    if (payload.role !== 'platform')
        throw (0, errors_1.forbidden)('Platform admin required');
    req.auth = payload;
    if (payload.sub === 0) {
        req.platform = {
            isOwner: true,
            adminId: 0,
            name: payload.name,
            permissions: { approve: true, freeze: true, renew: true, export: true },
        };
    }
    else {
        const admin = await platformAdminModel.findById(payload.sub);
        if (!admin)
            throw (0, errors_1.unauthorized)('Your admin access has been revoked');
        req.platform = {
            isOwner: false,
            adminId: admin.id,
            name: admin.name,
            permissions: platformAdminModel.toPublic(admin).permissions,
        };
    }
    next();
}
/** Owner-only platform routes: delete gym, settings, admin management. */
function requirePlatformOwner(req, _res, next) {
    if (!req.platform?.isOwner)
        throw (0, errors_1.forbidden)('Only the platform owner can do this');
    next();
}
/** Permission-gated platform routes (always granted to the owner). */
function requirePlatformPerm(perm) {
    return (req, _res, next) => {
        if (!req.platform?.permissions[perm]) {
            throw (0, errors_1.forbidden)('The platform owner has not granted you this permission');
        }
        next();
    };
}
/**
 * Blocks every tenant API call once the platform admin freezes the gym.
 * One indexed PK lookup per request — negligible at this scale.
 */
async function blockFrozenGym(req, _res, next) {
    const gym = await gymModel.findById(req.auth.gymId);
    if (!gym)
        throw (0, errors_1.unauthorized)('Gym no longer exists');
    if (gym.status === 'frozen') {
        throw (0, errors_1.forbidden)('This gym account has been frozen by the platform. Please contact support.', 'GYM_FROZEN');
    }
    if (gym.status === 'pending') {
        throw (0, errors_1.forbidden)('This gym registration has not been approved yet.', 'GYM_PENDING');
    }
    next();
}
/**
 * The paywall. Returns **402** with a machine-readable code — not 401 or 403,
 * which the client already spends on "log in again" and "you are frozen".
 *
 * Staff of an unpaid gym are still signed in and can reach /billing, /auth
 * and their own profile; they just cannot reach anything that costs us money
 * to run. The billing routes are registered before this middleware for exactly
 * that reason.
 *
 * The decision itself lives in billingService.hasAccess, which the client's
 * checkout payload also reports, so the two can never disagree.
 */
async function requireActiveSubscription(req, _res, next) {
    const settings = await billingModel.getSettings();
    if (!settings.payments_required)
        return next();
    const gym = await gymModel.findById(req.auth.gymId);
    if (!gym)
        throw (0, errors_1.unauthorized)('Gym no longer exists');
    if (billingService.hasAccess(gym, settings))
        return next();
    throw new errors_1.AppError(402, gym.subscription_ends_at
        ? 'Your subscription has expired. Renew it to continue using the system.'
        : 'Your gym does not have an active subscription yet. Pay to activate it.', 'PAYMENT_REQUIRED');
}
//# sourceMappingURL=auth.js.map