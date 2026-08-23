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
exports.adminRouter = void 0;
const express_1 = require("express");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const zod_1 = require("zod");
const async_1 = require("../utils/async");
const validate_1 = require("../middleware/validate");
const auth_1 = require("../middleware/auth");
const admin = __importStar(require("../controllers/platformAdminController"));
const billing = __importStar(require("../controllers/platformBillingController"));
/**
 * Platform admin API. Two levels of access:
 *  - the OWNER (env credentials): everything, including gym deletion,
 *    platform settings and managing sub-admins;
 *  - SUB-ADMINS (platform_admins table): read the dashboard, plus whatever
 *    per-account permissions the owner granted (approve/freeze/renew/export).
 *    They can never delete gyms — there is no permission for it.
 * Authenticated with a dedicated 'platform' JWT — completely separate from
 * gym staff accounts.
 */
exports.adminRouter = (0, express_1.Router)();
const adminLoginLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts — try again in a few minutes' },
});
exports.adminRouter.post('/login', adminLoginLimiter, (0, validate_1.validate)(zod_1.z.object({ email: zod_1.z.string().email(), password: zod_1.z.string().min(1) })), (0, async_1.asyncHandler)(admin.login));
exports.adminRouter.use((0, async_1.asyncHandler)(auth_1.requirePlatformAdmin));
// readable by every platform admin
exports.adminRouter.get('/me', (0, async_1.asyncHandler)(admin.me));
exports.adminRouter.get('/overview', (0, async_1.asyncHandler)(admin.overview));
exports.adminRouter.get('/gyms', (0, async_1.asyncHandler)(admin.listGyms));
exports.adminRouter.get('/gyms/:id', (0, async_1.asyncHandler)(admin.gymDetail));
exports.adminRouter.put('/gyms/:id/note', (0, validate_1.validate)(zod_1.z.object({ note: zod_1.z.string().max(1000).nullable() })), (0, async_1.asyncHandler)(admin.updateNote));
// permission-gated (the owner always passes)
exports.adminRouter.post('/gyms/:id/approve', (0, auth_1.requirePlatformPerm)('approve'), (0, async_1.asyncHandler)(admin.approveGym));
exports.adminRouter.post('/gyms/:id/renew', (0, auth_1.requirePlatformPerm)('renew'), 
// Body is optional: no body at all still means "+1 year", as it always did.
(0, validate_1.validate)(zod_1.z
    .object({ cycle: zod_1.z.enum(['MONTHLY', 'YEARLY']), fromNow: zod_1.z.boolean() })
    .partial()
    .default({})), (0, async_1.asyncHandler)(admin.renewGym));
exports.adminRouter.post('/gyms/:id/freeze', (0, auth_1.requirePlatformPerm)('freeze'), (0, validate_1.validate)(zod_1.z.object({ note: zod_1.z.string().max(1000).optional() })), (0, async_1.asyncHandler)(admin.freezeGym));
exports.adminRouter.post('/gyms/:id/unfreeze', (0, auth_1.requirePlatformPerm)('freeze'), (0, async_1.asyncHandler)(admin.unfreezeGym));
exports.adminRouter.get('/export', (0, auth_1.requirePlatformPerm)('export'), (0, async_1.asyncHandler)(admin.exportAllMembers));
exports.adminRouter.get('/gyms/:id/export', (0, auth_1.requirePlatformPerm)('export'), (0, async_1.asyncHandler)(admin.exportGymMembers));
// owner-only: settings, gym deletion, sub-admin management
exports.adminRouter.get('/settings', auth_1.requirePlatformOwner, (0, async_1.asyncHandler)(admin.getSettings));
exports.adminRouter.put('/settings', auth_1.requirePlatformOwner, (0, validate_1.validate)(zod_1.z
    .object({ trial_mode: zod_1.z.boolean(), trial_days: zod_1.z.number().int().min(1).max(365) })
    .partial()), (0, async_1.asyncHandler)(admin.updateSettings));
// Feature entitlements. Owner-only, matching the other structural switches
// (platform settings, comped status, gym deletion) rather than the
// day-to-day permissions granted to sub-admins.
exports.adminRouter.put('/gyms/:id/features', auth_1.requirePlatformOwner, (0, validate_1.validate)(zod_1.z
    .object({ camera_allowed: zod_1.z.boolean(), telegram_allowed: zod_1.z.boolean() })
    .partial()
    .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })), (0, async_1.asyncHandler)(admin.setFeatures));
exports.adminRouter.delete('/gyms/:id', auth_1.requirePlatformOwner, (0, validate_1.validate)(zod_1.z.object({ confirm_name: zod_1.z.string(), note: zod_1.z.string().max(1000).optional() })), (0, async_1.asyncHandler)(admin.deleteGym));
// ---------------------------------------------------------------- billing --
// Subscription billing: the master switch, our prices and payment accounts,
// and every verification attempt made by any gym. Settings and plans are
// owner-only (they decide who pays what); the attempts table and manual
// payment recording follow the existing `renew` permission.
const cycleSchema = zod_1.z.enum(['MONTHLY', 'YEARLY']);
exports.adminRouter.get('/billing/settings', auth_1.requirePlatformOwner, (0, async_1.asyncHandler)(billing.getSettings));
exports.adminRouter.put('/billing/settings', auth_1.requirePlatformOwner, (0, validate_1.validate)(zod_1.z
    .object({
    payments_required: zod_1.z.boolean(),
    cbe_enabled: zod_1.z.boolean(),
    cbe_account_number: zod_1.z.string().max(64).nullable(),
    cbe_account_name: zod_1.z.string().max(200).nullable(),
    telebirr_enabled: zod_1.z.boolean(),
    telebirr_phone: zod_1.z.string().max(32).nullable(),
    telebirr_account_name: zod_1.z.string().max(200).nullable(),
    currency: zod_1.z.string().min(1).max(8),
    receipt_max_age_days: zod_1.z.number().int().min(1).max(365),
    grace_days: zod_1.z.number().int().min(0).max(90),
    instructions: zod_1.z.string().max(4000).nullable(),
})
    .partial()), (0, async_1.asyncHandler)(billing.updateSettings));
const planBody = zod_1.z.object({
    name: zod_1.z.string().min(1).max(100),
    description: zod_1.z.string().max(1000).nullable().optional(),
    monthly_price: zod_1.z.number().nonnegative(),
    yearly_price: zod_1.z.number().nonnegative(),
    currency: zod_1.z.string().min(1).max(8).optional(),
    sort_order: zod_1.z.number().int().min(0).max(999).optional(),
    is_active: zod_1.z.boolean().optional(),
});
exports.adminRouter.get('/billing/plans', auth_1.requirePlatformOwner, (0, async_1.asyncHandler)(billing.listPlans));
exports.adminRouter.post('/billing/plans', auth_1.requirePlatformOwner, (0, validate_1.validate)(planBody), (0, async_1.asyncHandler)(billing.createPlan));
exports.adminRouter.put('/billing/plans/:id', auth_1.requirePlatformOwner, (0, validate_1.validate)(planBody.partial()), (0, async_1.asyncHandler)(billing.updatePlan));
exports.adminRouter.delete('/billing/plans/:id', auth_1.requirePlatformOwner, (0, async_1.asyncHandler)(billing.removePlan));
exports.adminRouter.get('/billing/payments', (0, async_1.asyncHandler)(billing.listAttempts));
exports.adminRouter.post('/gyms/:id/record-payment', (0, auth_1.requirePlatformPerm)('renew'), (0, validate_1.validate)(zod_1.z.object({
    planId: zod_1.z.number().int().positive().nullable().default(null),
    cycle: cycleSchema,
    amount: zod_1.z.number().nonnegative(),
    provider: zod_1.z.enum(['CASH', 'CBE', 'TELEBIRR']).default('CASH'),
    note: zod_1.z.string().min(1).max(1000),
    /** Omitted → the server starts trials today and stacks everyone else. */
    startNow: zod_1.z.boolean().optional(),
})), (0, async_1.asyncHandler)(billing.recordPayment));
exports.adminRouter.put('/gyms/:id/comped', auth_1.requirePlatformOwner, (0, validate_1.validate)(zod_1.z.object({ comped: zod_1.z.boolean() })), (0, async_1.asyncHandler)(billing.setComped));
const permsSchema = zod_1.z.object({
    approve: zod_1.z.boolean(),
    freeze: zod_1.z.boolean(),
    renew: zod_1.z.boolean(),
    export: zod_1.z.boolean(),
});
exports.adminRouter.get('/admins', auth_1.requirePlatformOwner, (0, async_1.asyncHandler)(admin.listAdmins));
exports.adminRouter.post('/admins', auth_1.requirePlatformOwner, (0, validate_1.validate)(zod_1.z.object({
    name: zod_1.z.string().min(1).max(100),
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(8).max(100),
    permissions: permsSchema,
})), (0, async_1.asyncHandler)(admin.createAdmin));
exports.adminRouter.put('/admins/:id', auth_1.requirePlatformOwner, (0, validate_1.validate)(zod_1.z
    .object({
    name: zod_1.z.string().min(1).max(100),
    password: zod_1.z.string().min(8).max(100),
    permissions: permsSchema.partial(),
})
    .partial()), (0, async_1.asyncHandler)(admin.updateAdmin));
exports.adminRouter.delete('/admins/:id', auth_1.requirePlatformOwner, (0, async_1.asyncHandler)(admin.removeAdmin));
//# sourceMappingURL=admin.js.map