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
exports.create = create;
exports.list = list;
exports.descriptors = descriptors;
exports.expire = expire;
exports.convert = convert;
const guestModel = __importStar(require("../models/guestModel"));
const memberModel = __importStar(require("../models/memberModel"));
const eventModel = __importStar(require("../models/eventModel"));
const auditLogModel = __importStar(require("../models/auditLogModel"));
const sockets_1 = require("../sockets");
const errors_1 = require("../utils/errors");
const dates_1 = require("../utils/dates");
/** Day pass ends at 23:59:59 local; trials add N extra days. */
function passEnd(validDays) {
    const d = new Date();
    d.setDate(d.getDate() + validDays);
    d.setHours(23, 59, 59, 999);
    return d;
}
async function create(req, res) {
    const guest = await guestModel.create({
        gym_id: req.auth.gymId,
        name: req.body.name,
        descriptor: req.body.descriptor ?? null,
        valid_until: passEnd(req.body.valid_days ?? 0),
        created_by: req.auth.sub,
    });
    const event = await eventModel.create({
        gym_id: req.auth.gymId,
        type: 'guest_added',
        severity: 'blue',
        message: `${guest.name} — guest pass created · valid until ${(0, dates_1.dateOnly)(new Date(guest.valid_until))}`,
    });
    (0, sockets_1.emitToGym)(req.auth.gymId, 'event:new', event);
    await auditLogModel.log({
        gym_id: req.auth.gymId,
        user_id: req.auth.sub,
        action: 'guest.created',
        entity: 'guest',
        entity_id: guest.id,
        meta: { valid_until: guest.valid_until },
    });
    res.status(201).json(guest);
}
async function list(req, res) {
    res.json(await guestModel.listByGym(req.auth.gymId));
}
/** Active guest descriptors — merged into the monitor's recognition cache. */
async function descriptors(req, res) {
    res.json(await guestModel.listActiveDescriptors(req.auth.gymId));
}
async function expire(req, res) {
    const guest = await guestModel.expireNow(req.auth.gymId, Number(req.params.id));
    if (!guest)
        throw (0, errors_1.notFound)('Guest not found');
    await auditLogModel.log({
        gym_id: req.auth.gymId,
        user_id: req.auth.sub,
        action: 'guest.expired',
        entity: 'guest',
        entity_id: guest.id,
    });
    res.json(guest);
}
/** Mark a guest as converted to an (already enrolled) member. */
async function convert(req, res) {
    const guestId = Number(req.params.id);
    const guest = await guestModel.findById(req.auth.gymId, guestId);
    if (!guest)
        throw (0, errors_1.notFound)('Guest not found');
    const member = await memberModel.findById(req.auth.gymId, req.body.member_id);
    if (!member)
        throw (0, errors_1.notFound)('Member not found');
    await guestModel.setConvertedMember(req.auth.gymId, guestId, member.id);
    await auditLogModel.log({
        gym_id: req.auth.gymId,
        user_id: req.auth.sub,
        action: 'guest.converted',
        entity: 'guest',
        entity_id: guestId,
        meta: { member_id: member.id },
    });
    res.json({ converted: true, member_id: member.id });
}
//# sourceMappingURL=guestController.js.map