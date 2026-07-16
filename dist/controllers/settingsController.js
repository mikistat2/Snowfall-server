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
exports.getGym = getGym;
exports.updateGym = updateGym;
exports.listStaff = listStaff;
exports.createStaff = createStaff;
exports.removeStaff = removeStaff;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const gymModel = __importStar(require("../models/gymModel"));
const userModel = __importStar(require("../models/userModel"));
const auditLogModel = __importStar(require("../models/auditLogModel"));
const errors_1 = require("../utils/errors");
const types_1 = require("../types");
async function getGym(req, res) {
    const gym = await gymModel.findById(req.auth.gymId);
    if (!gym)
        throw (0, errors_1.notFound)('Gym not found');
    res.json({ ...gym, settings: { ...types_1.DEFAULT_SETTINGS, ...gym.settings } });
}
async function updateGym(req, res) {
    const { settings, ...info } = req.body;
    let gym = await gymModel.findById(req.auth.gymId);
    if (!gym)
        throw (0, errors_1.notFound)('Gym not found');
    const tokenChanged = 'telegram_bot_token' in info && info.telegram_bot_token !== gym.telegram_bot_token;
    if (Object.keys(info).length > 0)
        gym = await gymModel.update(req.auth.gymId, info);
    if (tokenChanged) {
        const { restartBot } = await Promise.resolve().then(() => __importStar(require('../telegram/botManager')));
        void restartBot(req.auth.gymId, gym.telegram_bot_token).catch(() => undefined);
    }
    if (settings) {
        gym = await gymModel.updateSettings(req.auth.gymId, { ...types_1.DEFAULT_SETTINGS, ...gym.settings, ...settings });
    }
    await auditLogModel.log({
        gym_id: req.auth.gymId,
        user_id: req.auth.sub,
        action: 'settings.updated',
        entity: 'gym',
        entity_id: req.auth.gymId,
    });
    res.json(gym);
}
async function listStaff(req, res) {
    res.json(await userModel.listByGym(req.auth.gymId));
}
async function createStaff(req, res) {
    const existing = await userModel.findByEmail(req.body.email);
    if (existing)
        throw (0, errors_1.conflict)('An account with this email already exists');
    const user = await userModel.create({
        gym_id: req.auth.gymId,
        name: req.body.name,
        phone: req.body.phone ?? null,
        email: req.body.email,
        password_hash: await bcryptjs_1.default.hash(req.body.password, 10),
        role: 'staff',
    });
    await auditLogModel.log({
        gym_id: req.auth.gymId,
        user_id: req.auth.sub,
        action: 'staff.created',
        entity: 'user',
        entity_id: user.id,
    });
    res.status(201).json({ id: user.id, name: user.name, email: user.email, role: user.role });
}
async function removeStaff(req, res) {
    const id = Number(req.params.id);
    if (id === req.auth.sub)
        throw (0, errors_1.badRequest)('You cannot delete your own account');
    const target = await userModel.findById(id);
    if (!target || target.gym_id !== req.auth.gymId)
        throw (0, errors_1.notFound)('User not found');
    if (target.role === 'owner')
        throw (0, errors_1.badRequest)('Owner accounts cannot be deleted');
    await userModel.remove(req.auth.gymId, id);
    await auditLogModel.log({
        gym_id: req.auth.gymId,
        user_id: req.auth.sub,
        action: 'staff.removed',
        entity: 'user',
        entity_id: id,
    });
    res.status(204).end();
}
//# sourceMappingURL=settingsController.js.map