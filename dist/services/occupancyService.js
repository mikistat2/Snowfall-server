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
exports.getOccupancy = getOccupancy;
exports.adjust = adjust;
exports.resync = resync;
const checkInModel = __importStar(require("../models/checkInModel"));
const sockets_1 = require("../sockets");
/**
 * In-memory occupancy counter per gym, backed by the DB (open check_ins).
 * Lazily initialized from the DB, adjusted on check-in/checkout, and
 * re-synced from the DB whenever the cron closes stale sessions.
 */
const counters = new Map();
async function getOccupancy(gymId) {
    const cached = counters.get(gymId);
    if (cached !== undefined)
        return cached;
    const count = await checkInModel.countOpen(gymId);
    counters.set(gymId, count);
    return count;
}
async function adjust(gymId, delta) {
    const current = await getOccupancy(gymId);
    const next = Math.max(0, current + delta);
    counters.set(gymId, next);
    broadcast(gymId, next);
    return next;
}
/** Recount from the DB (used after bulk auto-checkout). */
async function resync(gymId) {
    const count = await checkInModel.countOpen(gymId);
    counters.set(gymId, count);
    broadcast(gymId, count);
    return count;
}
function broadcast(gymId, count) {
    (0, sockets_1.emitToGym)(gymId, 'occupancy:update', { count });
}
//# sourceMappingURL=occupancyService.js.map