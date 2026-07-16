"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.create = create;
exports.findValid = findValid;
exports.revoke = revoke;
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
//# sourceMappingURL=refreshTokenModel.js.map