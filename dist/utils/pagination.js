"use strict";
/**
 * Optional page params from a query string.
 *
 * Both are undefined when absent, which every model treats as "no limit" —
 * the desktop tables still get the full result set, so adding paging did not
 * change any existing response.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseLimit = parseLimit;
exports.parseOffset = parseOffset;
const MAX_LIMIT = 200;
function parseLimit(raw) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0)
        return undefined;
    return Math.min(Math.floor(value), MAX_LIMIT);
}
function parseOffset(raw) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0)
        return undefined;
    return Math.floor(value);
}
//# sourceMappingURL=pagination.js.map