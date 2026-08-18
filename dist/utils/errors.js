"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.conflict = exports.notFound = exports.forbidden = exports.unauthorized = exports.badRequest = exports.AppError = void 0;
class AppError extends Error {
    statusCode;
    code;
    constructor(statusCode, message, code) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.name = 'AppError';
    }
}
exports.AppError = AppError;
const badRequest = (msg, code) => new AppError(400, msg, code);
exports.badRequest = badRequest;
const unauthorized = (msg = 'Unauthorized') => new AppError(401, msg);
exports.unauthorized = unauthorized;
const forbidden = (msg = 'Forbidden', code) => new AppError(403, msg, code);
exports.forbidden = forbidden;
const notFound = (msg = 'Not found') => new AppError(404, msg);
exports.notFound = notFound;
const conflict = (msg) => new AppError(409, msg);
exports.conflict = conflict;
//# sourceMappingURL=errors.js.map