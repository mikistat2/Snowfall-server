"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorHandler = errorHandler;
const errors_1 = require("../utils/errors");
const env_1 = require("../config/env");
function errorHandler(err, _req, res, _next) {
    if (err instanceof errors_1.AppError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
    }
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({
        error: env_1.env.nodeEnv === 'development' && err instanceof Error ? err.message : 'Internal server error',
    });
}
//# sourceMappingURL=error.js.map