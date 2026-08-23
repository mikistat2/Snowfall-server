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
exports.api = void 0;
const express_1 = require("express");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const zod_1 = require("zod");
const async_1 = require("../utils/async");
const validate_1 = require("../middleware/validate");
const multer_1 = __importDefault(require("multer"));
const auth_1 = require("../middleware/auth");
const admin_1 = require("./admin");
const auth = __importStar(require("../controllers/authController"));
const plans = __importStar(require("../controllers/planController"));
const members = __importStar(require("../controllers/memberController"));
const checkIns = __importStar(require("../controllers/checkInController"));
const payments = __importStar(require("../controllers/paymentController"));
const dashboard = __importStar(require("../controllers/dashboardController"));
const settings = __importStar(require("../controllers/settingsController"));
const telegram = __importStar(require("../controllers/telegramController"));
const guests = __importStar(require("../controllers/guestController"));
const billing = __importStar(require("../controllers/billingController"));
const auditLogModel = __importStar(require("../models/auditLogModel"));
const platformModel = __importStar(require("../models/platformModel"));
const cameraProxyController_1 = require("../controllers/cameraProxyController");
const feedback = __importStar(require("../controllers/feedbackController"));
exports.api = (0, express_1.Router)();
// ---------- schemas ----------
const descriptor = zod_1.z.array(zod_1.z.number()).length(128);
const paymentMethod = zod_1.z.enum(['cash', 'telebirr', 'bank', 'other']);
const registerGymSchema = zod_1.z.object({
    gym: zod_1.z.object({
        name: zod_1.z.string().min(2),
        address: zod_1.z.string().optional(),
        phone: zod_1.z.string().optional(),
    }),
    owner: zod_1.z.object({
        name: zod_1.z.string().min(2),
        email: zod_1.z.string().email(),
        password: zod_1.z.string().min(8),
        phone: zod_1.z.string().optional(),
    }),
});
const planSchema = zod_1.z.object({
    name: zod_1.z.string().min(1),
    duration_days: zod_1.z.number().int().positive(),
    price: zod_1.z.number().nonnegative(),
    sessions_per_day: zod_1.z.literal(1).nullable().default(null),
    includes: zod_1.z.record(zod_1.z.boolean()).default({}),
    allowed_hours: zod_1.z
        .string()
        .regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/)
        .nullable()
        .default(null),
    active: zod_1.z.boolean().optional(),
});
const memberInfoSchema = zod_1.z.object({
    full_name: zod_1.z.string().min(2),
    phone: zod_1.z.string().optional(),
    sex: zod_1.z.enum(['male', 'female']).optional(),
    photo_url: zod_1.z.string().nullable().optional(),
});
const enrollSchema = zod_1.z.object({
    member: memberInfoSchema,
    descriptors: zod_1.z.array(descriptor).max(5).default([]),
    plan_id: zod_1.z.number().int().positive(),
    payment: zod_1.z.object({
        amount: zod_1.z.number().nonnegative().optional(),
        method: paymentMethod,
        note: zod_1.z.string().optional(),
    }),
});
/**
 * A member back-filled from the gym's paper register. The dates are whatever
 * was written on the paper — `calendar` says which system they are in, and the
 * service converts them before anything is stored.
 */
const dateOnlyString = zod_1.z.string().regex(/^\d{4}-\d{1,2}-\d{1,2}$/);
const previousMemberSchema = zod_1.z.object({
    member: memberInfoSchema,
    descriptors: zod_1.z.array(descriptor).max(5).default([]),
    plan_id: zod_1.z.number().int().positive(),
    calendar: zod_1.z.enum(['gregorian', 'ethiopian']),
    /** Provenance for the audit log; does not affect conversion. */
    entered_calendar: zod_1.z.enum(['gregorian', 'ethiopian']).optional(),
    joined_at: dateOnlyString,
    starts_at: dateOnlyString,
    /** Omitted = start date + the plan's duration. */
    expires_at: dateOnlyString.optional(),
    /** Omitted = the money was taken before the system existed and is not being recorded. */
    payment: zod_1.z
        .object({
        amount: zod_1.z.number().nonnegative().optional(),
        method: paymentMethod,
        note: zod_1.z.string().optional(),
    })
        .optional(),
});
/**
 * Admin correction of an existing member — a patch, so every key is optional
 * and an absent one means "leave it alone".
 *
 * Wider than `memberInfoSchema`: phone and sex are nullable here because
 * clearing a wrong value is as much a correction as typing a right one, and the
 * dates a member was created with are editable too. `subscription` rewrites the
 * member's current period in place; it never takes a payment.
 */
const memberUpdateSchema = zod_1.z
    .object({
    full_name: zod_1.z.string().min(2).optional(),
    phone: zod_1.z.string().nullable().optional(),
    sex: zod_1.z.enum(['male', 'female']).nullable().optional(),
    photo_url: zod_1.z.string().nullable().optional(),
    joined_at: dateOnlyString.optional(),
    subscription: zod_1.z
        .object({
        plan_id: zod_1.z.number().int().positive().optional(),
        starts_at: dateOnlyString.optional(),
        expires_at: dateOnlyString.optional(),
    })
        .optional(),
})
    .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
const renewSchema = zod_1.z.object({
    plan_id: zod_1.z.number().int().positive(),
    amount: zod_1.z.number().nonnegative().optional(),
    method: paymentMethod,
    note: zod_1.z.string().optional(),
});
const recognizeSchema = zod_1.z
    .object({
    member_id: zod_1.z.number().int().positive().optional(),
    guest_id: zod_1.z.number().int().positive().optional(),
    descriptor: descriptor.optional(),
    confidence: zod_1.z.number().optional(),
})
    .refine((v) => v.member_id !== undefined || v.guest_id !== undefined || v.descriptor !== undefined, {
    message: 'member_id, guest_id or descriptor required',
});
const guestSchema = zod_1.z.object({
    name: zod_1.z.string().min(2),
    descriptor: descriptor.nullable().optional(),
    valid_days: zod_1.z.number().int().min(0).max(30).default(0),
});
const settingsSchema = zod_1.z.object({
    name: zod_1.z.string().min(2).optional(),
    address: zod_1.z.string().nullable().optional(),
    phone: zod_1.z.string().nullable().optional(),
    telegram_bot_token: zod_1.z.string().nullable().optional(),
    settings: zod_1.z
        .object({
        grace_period_days: zod_1.z.number().int().min(0),
        auto_checkout_hours: zod_1.z.number().min(0.5),
        expiry_reminder_days: zod_1.z.number().int().min(0),
        absence_nudge_days: zod_1.z.number().int().min(1),
        match_threshold: zod_1.z.number().min(0.2).max(0.9),
        closing_time: zod_1.z.string().regex(/^\d{2}:\d{2}$/),
        entry_mode: zod_1.z.enum(['auto', 'manual']),
        camera_enabled: zod_1.z.boolean(),
    })
        .partial()
        .optional(),
});
// ---------- rate limits (per IP; trust proxy is set for Render) ----------
const authLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    limit: 20, // login/register attempts per 15 min
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts — try again in a few minutes' },
});
const feedbackLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 60 * 1000,
    limit: 10, // feedback mails per hour
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too much feedback at once — try again later' },
});
/**
 * Far harder than the rest of the API: every verify attempt spends a paid
 * verification credit, so this is a cost-control boundary and not just abuse
 * prevention.
 */
const verifyLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many verification attempts — wait a minute and try again' },
});
/**
 * Receipt screenshots, held in memory and decoded in-process (never written to
 * disk, never forwarded anywhere).
 *
 * 6 MB is deliberately well under the body limit: the multipart envelope adds
 * the other form fields and boundaries on top of the file, and overshooting
 * makes the body get dropped BEFORE validation runs — which surfaces as a
 * baffling "no file was uploaded".
 */
const receiptUpload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: 6 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => {
        cb(null, ['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype));
    },
});
// ---------- auth ----------
// public: lets the landing/registration pages advertise an active free trial
exports.api.get('/auth/registration-mode', (0, async_1.asyncHandler)(async (_req, res) => {
    const { trial_mode, trial_days } = await platformModel.getSettings();
    res.json({ trial_mode, trial_days });
}));
exports.api.post('/auth/register-gym', authLimiter, (0, validate_1.validate)(registerGymSchema), (0, async_1.asyncHandler)(auth.registerGym));
exports.api.post('/auth/login', authLimiter, (0, validate_1.validate)(zod_1.z.object({ email: zod_1.z.string().email(), password: zod_1.z.string() })), (0, async_1.asyncHandler)(auth.login));
exports.api.post('/auth/refresh', (0, validate_1.validate)(zod_1.z.object({ refreshToken: zod_1.z.string() })), (0, async_1.asyncHandler)(auth.refresh));
exports.api.post('/auth/logout', (0, validate_1.validate)(zod_1.z.object({ refreshToken: zod_1.z.string() })), (0, async_1.asyncHandler)(auth.logout));
// LAN camera stream proxy — authenticates via ?token= because <img>/<video>
// tags cannot send an Authorization header (registered before requireAuth).
exports.api.get('/camera-proxy', (0, async_1.asyncHandler)(cameraProxyController_1.cameraProxy));
// ---------- platform super-admin (product owner) ----------
exports.api.use('/admin', admin_1.adminRouter);
// everything below requires a logged-in staff member of a non-frozen gym
exports.api.use(auth_1.requireAuth);
exports.api.use((0, async_1.asyncHandler)(auth_1.blockFrozenGym));
// ---------- billing (deliberately NOT behind the paywall) ----------
// An unpaid gym is still signed in: it must be able to see what it owes and
// pay it. Everything after this block is gated on an active subscription.
const cycleSchema = zod_1.z.enum(['MONTHLY', 'YEARLY']);
const onlineProvider = zod_1.z.enum(['CBE', 'TELEBIRR']);
exports.api.get('/billing', (0, async_1.asyncHandler)(billing.checkout));
exports.api.get('/billing/payments', (0, async_1.asyncHandler)(billing.history));
exports.api.post('/billing/verify', verifyLimiter, auth_1.requireOwner, (0, validate_1.validate)(zod_1.z.object({
    provider: onlineProvider,
    reference: zod_1.z.string().min(4).max(200),
    planId: zod_1.z.number().int().positive(),
    cycle: cycleSchema,
})), (0, async_1.asyncHandler)(billing.verifyReference));
// multipart — validated inside the controller, since zod cannot see the file
exports.api.post('/billing/verify-screenshot', verifyLimiter, auth_1.requireOwner, receiptUpload.single('file'), (0, async_1.asyncHandler)(billing.verifyScreenshot));
exports.api.use((0, async_1.asyncHandler)(auth_1.requireActiveSubscription));
// ---------- plans ----------
exports.api.get('/plans', (0, async_1.asyncHandler)(plans.list));
exports.api.post('/plans', (0, validate_1.validate)(planSchema), (0, async_1.asyncHandler)(plans.create));
exports.api.put('/plans/:id', (0, validate_1.validate)(planSchema.partial()), (0, async_1.asyncHandler)(plans.update));
exports.api.delete('/plans/:id', (0, async_1.asyncHandler)(plans.remove));
// ---------- members ----------
exports.api.get('/members', (0, async_1.asyncHandler)(members.list));
exports.api.get('/members/descriptors', (0, auth_1.requireFeature)('camera'), (0, async_1.asyncHandler)(members.allDescriptors));
exports.api.get('/members/descriptors/version', (0, auth_1.requireFeature)('camera'), (0, async_1.asyncHandler)(members.descriptorsVersion));
exports.api.get('/members/export', (0, async_1.asyncHandler)(members.exportData)); // before /members/:id
exports.api.post('/members', (0, validate_1.validate)(enrollSchema), (0, async_1.asyncHandler)(members.enroll));
exports.api.post('/members/previous', (0, validate_1.validate)(previousMemberSchema), (0, async_1.asyncHandler)(members.enrollPrevious));
exports.api.get('/members/:id', (0, async_1.asyncHandler)(members.detail));
exports.api.put('/members/:id', (0, validate_1.validate)(memberUpdateSchema), (0, async_1.asyncHandler)(members.update));
exports.api.post('/members/:id/descriptors', (0, auth_1.requireFeature)('camera'), (0, validate_1.validate)(zod_1.z.object({ descriptors: zod_1.z.array(descriptor).min(1).max(5), replace: zod_1.z.boolean().optional() })), (0, async_1.asyncHandler)(members.addDescriptors));
exports.api.post('/members/:id/renew', (0, validate_1.validate)(renewSchema), (0, async_1.asyncHandler)(members.renew));
// Removing someone is owner-only, like every other destructive action here.
// Archive keeps the payment history; DELETE is refused for anyone who has any.
exports.api.post('/members/:id/archive', auth_1.requireOwner, (0, async_1.asyncHandler)(members.archive));
exports.api.post('/members/:id/restore', auth_1.requireOwner, (0, async_1.asyncHandler)(members.restore));
exports.api.delete('/members/:id', auth_1.requireOwner, (0, async_1.asyncHandler)(members.remove));
exports.api.post('/members/:id/freeze', (0, async_1.asyncHandler)(members.freeze));
exports.api.post('/members/:id/unfreeze', (0, async_1.asyncHandler)(members.unfreeze));
// ---------- check-ins / monitor ----------
exports.api.post('/check-ins/recognize', (0, auth_1.requireFeature)('camera'), (0, validate_1.validate)(recognizeSchema), (0, async_1.asyncHandler)(checkIns.recognize));
exports.api.post('/check-ins/override', (0, validate_1.validate)(zod_1.z.object({ member_id: zod_1.z.number().int().positive() })), (0, async_1.asyncHandler)(checkIns.override));
exports.api.post('/check-ins/approve', (0, validate_1.validate)(zod_1.z.object({ member_id: zod_1.z.number().int().positive() })), (0, async_1.asyncHandler)(checkIns.approve));
exports.api.get('/check-ins/open', (0, async_1.asyncHandler)(checkIns.listOpen));
exports.api.post('/check-ins/:id/checkout', (0, async_1.asyncHandler)(checkIns.checkout));
exports.api.get('/occupancy', (0, async_1.asyncHandler)(checkIns.occupancy));
exports.api.get('/events', (0, async_1.asyncHandler)(checkIns.recentEvents));
// ---------- guests (Phase 3) ----------
exports.api.get('/guests', (0, async_1.asyncHandler)(guests.list));
exports.api.get('/guests/descriptors', (0, auth_1.requireFeature)('camera'), (0, async_1.asyncHandler)(guests.descriptors));
exports.api.post('/guests', (0, validate_1.validate)(guestSchema), (0, async_1.asyncHandler)(guests.create));
exports.api.post('/guests/:id/expire', (0, async_1.asyncHandler)(guests.expire));
exports.api.post('/guests/:id/convert', (0, validate_1.validate)(zod_1.z.object({ member_id: zod_1.z.number().int().positive() })), (0, async_1.asyncHandler)(guests.convert));
// ---------- audit log (Phase 3, owner only) ----------
exports.api.get('/audit-logs', auth_1.requireOwner, (0, async_1.asyncHandler)(async (req, res) => {
    res.json(await auditLogModel.list(req.auth.gymId, {
        entity: req.query.entity,
        action: req.query.action,
    }));
}));
// ---------- telegram / notifications (Phase 2) ----------
exports.api.post('/members/:id/telegram-link', (0, auth_1.requireFeature)('telegram'), (0, async_1.asyncHandler)(telegram.memberLink));
exports.api.post('/telegram/owner-link', (0, auth_1.requireFeature)('telegram'), (0, async_1.asyncHandler)(telegram.ownerLink));
exports.api.get('/telegram/status', (0, async_1.asyncHandler)(telegram.status));
exports.api.get('/notifications', (0, async_1.asyncHandler)(telegram.notifications));
// ---------- payments / dashboard ----------
exports.api.get('/payments', (0, async_1.asyncHandler)(payments.list));
exports.api.get('/dashboard/stats', (0, async_1.asyncHandler)(dashboard.stats));
exports.api.get('/dashboard/today', (0, async_1.asyncHandler)(dashboard.today));
// ---------- feedback (emailed to product owner) ----------
exports.api.post('/feedback', feedbackLimiter, (0, validate_1.validate)(zod_1.z.object({
    category: zod_1.z.enum(['suggestion', 'bug', 'improvement', 'other']),
    subject: zod_1.z.string().max(200).optional(),
    message: zod_1.z.string().min(1).max(5000),
})), (0, async_1.asyncHandler)(feedback.submit));
// ---------- settings / staff (owner only for writes) ----------
exports.api.get('/settings', (0, async_1.asyncHandler)(settings.getGym));
exports.api.put('/settings', auth_1.requireOwner, (0, validate_1.validate)(settingsSchema), (0, async_1.asyncHandler)(settings.updateGym));
exports.api.get('/staff', (0, async_1.asyncHandler)(settings.listStaff));
exports.api.post('/staff', auth_1.requireOwner, (0, validate_1.validate)(zod_1.z.object({
    name: zod_1.z.string().min(2),
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(8),
    phone: zod_1.z.string().optional(),
})), (0, async_1.asyncHandler)(settings.createStaff));
exports.api.delete('/staff/:id', auth_1.requireOwner, (0, async_1.asyncHandler)(settings.removeStaff));
//# sourceMappingURL=index.js.map