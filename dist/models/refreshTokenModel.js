"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.create = create;
exports.findValid = findValid;
exports.revoke = revoke;
exports.revokeAllForUser = revokeAllForUser;
const knex_1 = require("../db/knex");
async function create(userId, tokenHash, expiresAt) {
    await (0, knex_1.db)('refresh_tokens').insert({ user_id: userId, token_hash: tokenHash, expires_at: expiresAt });
}
async function findValid(tokenHash) {
    return (0, knex_1.db)('refresh_tokens')
        .where({ token_hash: tokenHash })
        .whereNull('revoked_at')
        .where('expires_at', '>', knex_1.db.fn.now())
        .first();
}
async function revoke(tokenHash) {
    await (0, knex_1.db)('refresh_tokens').where({ token_hash: tokenHash }).update({ revoked_at: knex_1.db.fn.now() });
}
/**
 * Kill every session of one account.
 *
 * A hard DELETE of the user used to do this implicitly (refresh_tokens
 * cascades from users). Removal is now a tombstone, so the sessions have to be
 * revoked by hand — otherwise a removed employee's phone keeps refreshing its
 * way back in for the full refresh-token lifetime.
 */
async function revokeAllForUser(userId) {
    return (0, knex_1.db)('refresh_tokens')
        .where({ user_id: userId })
        .whereNull('revoked_at')
        .update({ revoked_at: knex_1.db.fn.now() });
}
//# sourceMappingURL=refreshTokenModel.js.map