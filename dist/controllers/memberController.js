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
exports.detail = detail;
exports.enroll = enroll;
exports.update = update;
exports.allDescriptors = allDescriptors;
exports.addDescriptors = addDescriptors;
exports.renew = renew;
exports.freeze = freeze;
exports.unfreeze = unfreeze;
const memberModel = __importStar(require("../models/memberModel"));
const memberService = __importStar(require("../services/memberService"));
const paymentService = __importStar(require("../services/paymentService"));
const auditLogModel = __importStar(require("../models/auditLogModel"));
const errors_1 = require("../utils/errors");
async function list(req, res) {
    res.json(await memberModel.listByGym(req.auth.gymId, {
        search: req.query.search,
        status: req.query.status,
    }));
}
async function detail(req, res) {
    res.json(await memberService.detail(req.auth.gymId, Number(req.params.id)));
}
async function enroll(req, res) {
    const member = await memberService.enroll({
        gymId: req.auth.gymId,
        userId: req.auth.sub,
        member: req.body.member,
        descriptors: req.body.descriptors ?? [],
        planId: req.body.plan_id,
        payment: req.body.payment,
    });
    res.status(201).json(member);
}
async function update(req, res) {
    const member = await memberModel.update(req.auth.gymId, Number(req.params.id), req.body);
    if (!member)
        throw (0, errors_1.notFound)('Member not found');
    await auditLogModel.log({
        gym_id: req.auth.gymId,
        user_id: req.auth.sub,
        action: 'member.updated',
        entity: 'member',
        entity_id: member.id,
    });
    res.json(member);
}
/** All descriptors for the gym — the monitor page's recognition cache. */
async function allDescriptors(req, res) {
    res.json(await memberModel.listDescriptorsByGym(req.auth.gymId));
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
async function freeze(req, res) {
    await memberService.freeze(req.auth.gymId, Number(req.params.id), req.auth.sub);
    res.json({ frozen: true });
}
async function unfreeze(req, res) {
    await memberService.unfreeze(req.auth.gymId, Number(req.params.id), req.auth.sub);
    res.json({ frozen: false });
}
//# sourceMappingURL=memberController.js.map