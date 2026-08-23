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
exports.list = list;
exports.exportData = exportData;
exports.detail = detail;
exports.enroll = enroll;
exports.enrollPrevious = enrollPrevious;
exports.update = update;
exports.allDescriptors = allDescriptors;
exports.descriptorsVersion = descriptorsVersion;
exports.addDescriptors = addDescriptors;
exports.renew = renew;
exports.archive = archive;
exports.restore = restore;
exports.remove = remove;
exports.freeze = freeze;
exports.unfreeze = unfreeze;
const memberModel = __importStar(require("../models/memberModel"));
const memberService = __importStar(require("../services/memberService"));
const paymentService = __importStar(require("../services/paymentService"));
const errors_1 = require("../utils/errors");
const pagination_1 = require("../utils/pagination");
async function list(req, res) {
    res.json(await memberModel.listByGym(req.auth.gymId, {
        search: req.query.search,
        status: req.query.status,
        archived: req.query.archived === 'true',
        limit: (0, pagination_1.parseLimit)(req.query.limit),
        offset: (0, pagination_1.parseOffset)(req.query.offset),
    }));
}
/** Full data dump for the client-side PDF export. */
async function exportData(req, res) {
    res.json(await memberModel.exportByGym(req.auth.gymId));
}
async function detail(req, res) {
    res.json(await memberService.detail(req.auth.gymId, Number(req.params.id)));
}
/**
 * Enrolment stays open with the camera revoked — a gym in name-board mode
 * still signs members up — but face captures sent alongside are dropped
 * rather than stored. The route is therefore not behind requireFeature; this
 * is the narrower rule it needs.
 */
function allowedDescriptors(req) {
    if (!req.gym?.camera_allowed)
        return [];
    return req.body.descriptors ?? [];
}
async function enroll(req, res) {
    const member = await memberService.enroll({
        gymId: req.auth.gymId,
        userId: req.auth.sub,
        member: req.body.member,
        descriptors: allowedDescriptors(req),
        planId: req.body.plan_id,
        payment: req.body.payment,
    });
    res.status(201).json(member);
}
/** Back-fill of a member from the gym's pre-installation paper register. */
async function enrollPrevious(req, res) {
    const member = await memberService.enrollPrevious({
        gymId: req.auth.gymId,
        userId: req.auth.sub,
        member: req.body.member,
        descriptors: allowedDescriptors(req),
        planId: req.body.plan_id,
        calendar: req.body.calendar,
        enteredCalendar: req.body.entered_calendar,
        joinedAt: req.body.joined_at,
        startsAt: req.body.starts_at,
        expiresAt: req.body.expires_at,
        payment: req.body.payment,
    });
    res.status(201).json(member);
}
/**
 * Admin correction of a member.
 *
 * The body is a patch: only the keys that were sent are touched, so the modal
 * can post the contact fields alone and leave the dates exactly as they are.
 * `member.*` is flat at the top level for backwards compatibility with the
 * original name/phone-only endpoint; the dates arrive under their own keys.
 *
 * Everything is Gregorian by the time it gets here — the client's date field
 * converts as you type, the same way the previous-member form does.
 */
async function update(req, res) {
    const { joined_at, subscription, ...member } = req.body;
    // Moving an expiry date hands out gym time without a payment behind it, so it
    // sits with the other owner-only actions (archive, delete, the audit log).
    // Correcting a name or a phone number stays open to staff at the desk.
    if (subscription && req.auth.role !== 'owner') {
        throw (0, errors_1.forbidden)('Only the owner can change a membership’s plan or dates');
    }
    const updated = await memberService.updateMember({
        gymId: req.auth.gymId,
        userId: req.auth.sub,
        memberId: Number(req.params.id),
        member: Object.keys(member).length > 0 ? member : undefined,
        joinedAt: joined_at,
        subscription: subscription
            ? {
                planId: subscription.plan_id,
                startsAt: subscription.starts_at,
                expiresAt: subscription.expires_at,
            }
            : undefined,
    });
    res.json(updated);
}
/** All descriptors for the gym — the monitor page's recognition cache. */
async function allDescriptors(req, res) {
    res.json(await memberModel.listDescriptorsByGym(req.auth.gymId));
}
/**
 * Change-token for the above. The monitor polls this every 60s (~50 bytes)
 * and only re-downloads the megabyte-scale descriptor payload when it moves.
 */
async function descriptorsVersion(req, res) {
    res.json({ version: await memberModel.descriptorsVersion(req.auth.gymId) });
}
async function addDescriptors(req, res) {
    const memberId = Number(req.params.id);
    const member = await memberModel.findById(req.auth.gymId, memberId);
    if (!member)
        throw (0, errors_1.notFound)('Member not found');
    if (req.body.replace)
        await memberModel.clearDescriptors(memberId);
    await memberModel.addDescriptors(memberId, req.body.descriptors);
    res.status(201).json({ count: await memberModel.descriptorCount(memberId) });
}
async function renew(req, res) {
    res.json(await paymentService.renew({
        gymId: req.auth.gymId,
        memberId: Number(req.params.id),
        planId: req.body.plan_id,
        amount: req.body.amount,
        method: req.body.method,
        note: req.body.note,
        userId: req.auth.sub,
    }));
}
/** Off the roster, money history intact. */
async function archive(req, res) {
    res.json(await memberService.archive(req.auth.gymId, Number(req.params.id), req.auth.sub));
}
async function restore(req, res) {
    res.json(await memberService.restore(req.auth.gymId, Number(req.params.id), req.auth.sub));
}
/** Permanent — refused (400) for anyone who has ever paid. */
async function remove(req, res) {
    await memberService.remove(req.auth.gymId, Number(req.params.id), req.auth.sub);
    res.json({ deleted: true });
}
async function freeze(req, res) {
    await memberService.freeze(req.auth.gymId, Number(req.params.id), req.auth.sub);
    res.json({ frozen: true });
}
async function unfreeze(req, res) {
    await memberService.unfreeze(req.auth.gymId, Number(req.params.id), req.auth.sub);
    res.json({ frozen: false });
}
//# sourceMappingURL=memberController.js.map