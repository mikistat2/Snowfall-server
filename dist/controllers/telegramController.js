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
exports.memberLink = memberLink;
exports.ownerLink = ownerLink;
exports.status = status;
exports.notifications = notifications;
const crypto_1 = __importDefault(require("crypto"));
const memberModel = __importStar(require("../models/memberModel"));
const userModel = __importStar(require("../models/userModel"));
const notificationModel = __importStar(require("../models/notificationModel"));
const botManager = __importStar(require("../telegram/botManager"));
const errors_1 = require("../utils/errors");
function requireRunningBot(gymId) {
    const status = botManager.getStatus(gymId);
    if (!status.running || !status.username) {
        throw (0, errors_1.badRequest)(status.error
            ? `Telegram bot is not running: ${status.error}`
            : 'Configure a Telegram bot token in Settings first');
    }
    return status.username;
}
/** One-time deep link for a member: t.me/<bot>?start=m<token> */
async function memberLink(req, res) {
    const username = requireRunningBot(req.auth.gymId);
    const memberId = Number(req.params.id);
    const member = await memberModel.findById(req.auth.gymId, memberId);
    if (!member)
        throw (0, errors_1.notFound)('Member not found');
    const token = crypto_1.default.randomBytes(12).toString('hex');
    await memberModel.setLinkToken(req.auth.gymId, memberId, token);
    res.json({
        url: `https://t.me/${username}?start=m${token}`,
        bot_username: username,
        already_linked: member.telegram_chat_id !== null,
    });
}
/** One-time deep link binding the current staff account's chat (admin alerts). */
async function ownerLink(req, res) {
    const username = requireRunningBot(req.auth.gymId);
    const token = crypto_1.default.randomBytes(12).toString('hex');
    await userModel.setLinkToken(req.auth.gymId, req.auth.sub, token);
    res.json({ url: `https://t.me/${username}?start=a${token}`, bot_username: username });
}
async function status(req, res) {
    const me = await userModel.findById(req.auth.sub);
    res.json({
        ...botManager.getStatus(req.auth.gymId),
        my_chat_linked: me?.telegram_chat_id != null,
    });
}
async function notifications(req, res) {
    res.json(await notificationModel.list(req.auth.gymId, {
        type: req.query.type,
        status: req.query.status,
    }));
}
//# sourceMappingURL=telegramController.js.map