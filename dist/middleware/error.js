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
    // Multer rejects an oversized or wrong-typed upload before the route runs;
    // its raw message ("File too large") is no use to whoever is uploading.
    if (isMulterError(err)) {
        res.status(400).json({
            error: err.code === 'LIMIT_FILE_SIZE'
                ? 'That screenshot is larger than 6 MB. Crop it to just the receipt, or take a smaller screenshot.'
                : 'That upload was rejected. Send a single PNG, JPG or WebP image up to 6 MB.',
        });
        return;
    }
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({
        error: env_1.env.nodeEnv === 'development' && err instanceof Error ? err.message : 'Internal server error',
    });
}
function isMulterError(err) {
    return err?.name === 'MulterError';
}
//# sourceMappingURL=error.js.map