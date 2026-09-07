"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findByEmail = findByEmail;
exports.findById = findById;
exports.findAnyById = findAnyById;
exports.listByGym = listByGym;
exports.isLive = isLive;
exports.create = create;
exports.softDelete = softDelete;
exports.restore = restore;
exports.countLiveOwners = countLiveOwners;
exports.setLinkToken = setLinkToken;
exports.findByLinkToken = findByLinkToken;
exports.bindTelegram = bindTelegram;
exports.ownerChatIds = ownerChatIds;
const knex_1 = require("../db/knex");
/**
 * Staff accounts.
 *
 * Removal is a tombstone, not a DELETE (see the 20260907000015 migration): the
 * row stays so `payments.marked_by` still resolves to a name. Everything that
 * asks "is there a user" therefore has to say `deleted_at IS NULL`, and the
 * only two functions here that do not are `findAnyById` and `listByGymAll` —
 * both reserved for the platform panel, which is the one place a removed
 * account is supposed to be visible so it can be restored.
 */
async function findByEmail(email) {
    return (0, knex_1.db)('users').whereRaw('lower(email) = lower(?)', [email]).whereNull('deleted_at').first();
}
async function findById(id) {
    return (0, knex_1.db)('users').where({ id }).whereNull('deleted_at').first();
}
/** Including removed accounts — platform panel only (restore needs the row). */
async function findAnyById(id) {
    return (0, knex_1.db)('users').where({ id }).first();
}
async function listByGym(gymId) {
    return (0, knex_1.db)('users')
        .where({ gym_id: gymId })
        .whereNull('deleted_at')
        .select('id', 'gym_id', 'name', 'phone', 'email', 'role', 'created_at')
        .orderBy('id');
}
/**
 * Access-token holders are not re-checked per request (`requireAuth` only
 * verifies the signature), so without this a removed account keeps working for
 * the remaining life of its access token — up to 15 minutes of a locked-out
 * employee still using the system. blockFrozenGym calls it on every
 * authenticated request; see the note there about the cost.
 */
async function isLive(id) {
    const row = await (0, knex_1.db)('users').where({ id }).whereNull('deleted_at').first('id');
    return Boolean(row);
}
async function create(data, trx = knex_1.db) {
    const [row] = await trx('users').insert(data).returning('*');
    return row;
}
/**
 * Remove an account. Returns 0 if it was already removed or never belonged to
 * this gym, so callers can treat a double-click as "nothing to do" rather than
 * writing a second tombstone over the first and losing who removed it.
 *
 * Revoking their refresh tokens is the caller's job — a hard delete used to
 * get that for free through ON DELETE CASCADE, and a tombstone does not.
 */
async function softDelete(gymId, id, by) {
    return (0, knex_1.db)('users')
        .where({ gym_id: gymId, id })
        .whereNull('deleted_at')
        .update({ deleted_at: knex_1.db.fn.now(), deleted_by: by });
}
/** Undo. Sessions stay revoked — they sign in again. */
async function restore(gymId, id) {
    return (0, knex_1.db)('users')
        .where({ gym_id: gymId, id })
        .whereNotNull('deleted_at')
        .update({ deleted_at: null, deleted_by: null });
}
/**
 * Live owners of a gym. Guards the removal of the last one: a gym with no
 * owner has nobody who can sign in, add staff back, or receive the alerts that
 * would explain why.
 */
async function countLiveOwners(gymId) {
    const row = await (0, knex_1.db)('users')
        .where({ gym_id: gymId, role: 'owner' })
        .whereNull('deleted_at')
        .count('id as count')
        .first();
    return Number(row?.count ?? 0);
}
async function setLinkToken(gymId, userId, token) {
    await (0, knex_1.db)('users').where({ gym_id: gymId, id: userId }).update({ telegram_link_token: token });
}
async function findByLinkToken(token) {
    return (0, knex_1.db)('users').where({ telegram_link_token: token }).whereNull('deleted_at').first();
}
async function bindTelegram(userId, chatId) {
    await (0, knex_1.db)('users').where({ id: userId }).update({ telegram_chat_id: chatId, telegram_link_token: null });
}
/** Owner chat ids for a gym (admin alerts / daily summary). */
async function ownerChatIds(gymId) {
    const rows = await (0, knex_1.db)('users')
        .where({ gym_id: gymId, role: 'owner' })
        .whereNull('deleted_at')
        .whereNotNull('telegram_chat_id')
        .select('telegram_chat_id');
    return rows.map((r) => Number(r.telegram_chat_id));
}
//# sourceMappingURL=userModel.js.map