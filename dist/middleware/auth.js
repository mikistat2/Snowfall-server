"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = requireAuth;
exports.requireOwner = requireOwner;
const jwt_1 = require("../utils/jwt");
const errors_1 = require("../utils/errors");
function requireAuth(req, _res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer '))
        throw (0, errors_1.unauthorized)('Missing bearer token');
    req.auth = (0, jwt_1.verifyAccessToken)(header.slice(7));
    next();
}
function requireOwner(req, _res, next) {
    if (req.auth.role !== 'owner')
        throw (0, errors_1.forbidden)('Owner role required');
    next();
}
//# sourceMappingURL=auth.js.map