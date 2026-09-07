"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.asyncHandler = void 0;
exports.timeboxed = timeboxed;
/** Wraps an async controller so rejections reach the error middleware. */
const asyncHandler = (fn) => (req, res, next) => {
    fn(req, res, next).catch(next);
};
exports.asyncHandler = asyncHandler;
/**
 * Resolves to `undefined` if `promise` has not settled within `ms`.
 *
 * For best-effort side work hanging off a request that has already succeeded —
 * an owner alert over Telegram or SMTP, say. The gym's payment went through; a
 * mail server that takes thirty seconds to answer must not hold the response
 * open that long, and its silence is not an error worth reporting.
 *
 * The timer is unref'd so a pending one never keeps the process alive.
 */
async function timeboxed(promise, ms = 4000) {
    return Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => resolve(undefined), ms).unref?.()),
    ]);
}
//# sourceMappingURL=async.js.map