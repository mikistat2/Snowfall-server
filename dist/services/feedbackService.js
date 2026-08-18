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
exports.isMailConfigured = void 0;
exports.sendFeedback = sendFeedback;
const env_1 = require("../config/env");
const gymModel = __importStar(require("../models/gymModel"));
const userModel = __importStar(require("../models/userModel"));
const errors_1 = require("../utils/errors");
const mailer_1 = require("./mailer");
Object.defineProperty(exports, "isMailConfigured", { enumerable: true, get: function () { return mailer_1.isMailConfigured; } });
const CATEGORY_LABELS = {
    suggestion: 'Suggestion',
    bug: 'Bug report',
    improvement: 'Improvement idea',
    other: 'Other',
};
async function sendFeedback(input) {
    const transport = (0, mailer_1.getTransport)();
    if (!transport) {
        throw (0, errors_1.badRequest)('Feedback email is not configured on the server (set SMTP_USER and SMTP_PASS).', 'mail_not_configured');
    }
    const [gym, user] = await Promise.all([
        gymModel.findById(input.gymId),
        userModel.findById(input.userId),
    ]);
    const catLabel = CATEGORY_LABELS[input.category] ?? input.category;
    const subject = `[Snowfall GMS · ${catLabel}] ${input.subject || 'Feedback'}`;
    const lines = [
        input.message,
        '',
        '────────────────────────',
        `Type:    ${catLabel}`,
        `Gym:     ${gym?.name ?? '-'} (id ${input.gymId})`,
        `Phone:   ${gym?.phone ?? '-'}`,
        `From:    ${user?.name ?? '-'} <${user?.email ?? '-'}>`,
        `Role:    ${user?.role ?? '-'}`,
        `Sent:    ${new Date().toISOString()}`,
    ];
    await transport.sendMail({
        from: `"Snowfall GMS Feedback" <${env_1.env.mail.user}>`,
        to: env_1.env.mail.feedbackTo,
        replyTo: user?.email ? `"${user.name}" <${user.email}>` : undefined,
        subject,
        text: lines.join('\n'),
    });
}
//# sourceMappingURL=feedbackService.js.map