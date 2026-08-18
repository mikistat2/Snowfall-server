"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTransport = getTransport;
exports.isMailConfigured = isMailConfigured;
const nodemailer_1 = __importDefault(require("nodemailer"));
const env_1 = require("../config/env");
/**
 * Shared Gmail SMTP transport (feedback mails + platform alerts).
 * Disabled until SMTP_USER + SMTP_PASS (App Password) are set.
 */
let transporter = null;
function getTransport() {
    if (!env_1.env.mail.user || !env_1.env.mail.pass)
        return null;
    transporter ??= nodemailer_1.default.createTransport({
        service: 'gmail',
        auth: { user: env_1.env.mail.user, pass: env_1.env.mail.pass },
        // fail fast instead of hanging API requests when SMTP is slow/blocked
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
    });
    return transporter;
}
function isMailConfigured() {
    return getTransport() !== null;
}
//# sourceMappingURL=mailer.js.map