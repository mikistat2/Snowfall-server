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
exports.recognize = recognize;
exports.override = override;
exports.approve = approve;
exports.checkout = checkout;
exports.listOpen = listOpen;
exports.occupancy = occupancy;
exports.recentEvents = recentEvents;
const checkInService = __importStar(require("../services/checkInService"));
const checkInModel = __importStar(require("../models/checkInModel"));
const eventModel = __importStar(require("../models/eventModel"));
const occupancyService = __importStar(require("../services/occupancyService"));
async function recognize(req, res) {
    res.json(await checkInService.recognize({
        gymId: req.auth.gymId,
        memberId: req.body.member_id,
        guestId: req.body.guest_id,
        descriptor: req.body.descriptor,
        confidence: req.body.confidence,
    }));
}
async function override(req, res) {
    res.json(await checkInService.override(req.auth.gymId, req.body.member_id, req.auth.sub));
}
async function approve(req, res) {
    res.json(await checkInService.approve(req.auth.gymId, req.body.member_id, req.auth.sub));
}
async function checkout(req, res) {
    await checkInService.checkout(req.auth.gymId, Number(req.params.id));
    res.json({ checked_out: true });
}
async function listOpen(req, res) {
    res.json(await checkInModel.listOpen(req.auth.gymId));
}
async function occupancy(req, res) {
    res.json({ count: await occupancyService.getOccupancy(req.auth.gymId) });
}
async function recentEvents(req, res) {
    res.json(await eventModel.listRecent(req.auth.gymId, Number(req.query.limit ?? 50)));
}
//# sourceMappingURL=checkInController.js.map