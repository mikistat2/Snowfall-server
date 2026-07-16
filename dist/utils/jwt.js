"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.signAccessToken = signAccessToken;
exports.verifyAccessToken = verifyAccessToken;
exports.generateRefreshToken = generateRefreshToken;
exports.hashRefreshToken = hashRefreshToken;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const crypto_1 = __importDefault(require("crypto"));
const env_1 = require("../config/env");
const errors_1 = require("./errors");
function signAccessToken(payload) {
    return jsonwebtoken_1.default.sign(payload, env_1.env.jwt.accessSecret, {
        expiresIn: env_1.env.jwt.accessTtl,
    });
}
function verifyAccessToken(token) {
    try {
        return jsonwebtoken_1.default.verify(token, env_1.env.jwt.accessSecret);
    }
    catch {
        throw (0, errors_1.unauthorized)('Invalid or expired access token');
    }
}
/** Opaque refresh tokens: random 256-bit value, stored hashed (sha256). */
function generateRefreshToken() {
    const token = crypto_1.default.randomBytes(32).toString('hex');
    return {
        token,
        hash: hashRefreshToken(token),
        expiresAt: new Date(Date.now() + env_1.env.jwt.refreshTtlDays * 24 * 60 * 60 * 1000),
    };
}
function hashRefreshToken(token) {
    return crypto_1.default.createHash('sha256').update(token).digest('hex');
}
//# sourceMappingURL=jwt.js.map