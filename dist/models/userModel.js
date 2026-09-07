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
 * asks "is there a user" therefore has to say `deleted_at IS NULL`. The one
 * exception is `findAnyById`, for the platform panel — the only screen that
 * can restore an account, and it cannot restore what it cannot see.
 * (platformModel.gymStaff is the matching unfiltered list for that screen.)
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
 * Remove an account, refusing to take a gym's last live owner with it — a gym
 * with no owner has nobody who can sign in, nobody who can add staff back, and
 * no recipient for any of the alerts that would explain it.
 *
 * The owner rows are locked before the count is read, and the whole thing is
 * one transaction, because the check is otherwise a lie under concurrency: two
 * requests removing two different owners at the same instant would each see
 * the other still present and both succeed, which is precisely the state the
 * check exists to prevent. `orderBy('id')` fixes the lock order so two such
 * requests queue instead of deadlocking.
 *
 * 'already-removed' rather than a silent success, so a double-click cannot
 * write a second tombstone over the first and lose who removed it and when.
 *
 * Revoking their refresh tokens is the caller's job — a hard delete used to
 * get that for free through ON DELETE CASCADE, and a tombstone does not.
 */
async function softDelete(gymId, id, by) {
    return knex_1.db.transaction(async (trx) => {
        const owners = await trx('users')
            .where({ gym_id: gymId, role: 'owner' })
            .whereNull('deleted_at')
            .orderBy('id')
            .forUpdate()
            .select('id');
        const target = await trx('users')
            .where({ gym_id: gymId, id })
            .whereNull('deleted_at')
            .first('role');
        if (!target)
            return 'already-removed';
        if (target.role === 'owner' && owners.length <= 1)
            return 'last-owner';
        await trx('users').where({ gym_id: gymId, id }).update({ deleted_at: trx.fn.now(), deleted_by: by });
        return 'removed';
    });
}
/**
 * Undo. Sessions stay revoked — they sign in again.
 *
 * The email may have been handed to somebody else while this account was
 * removed (that is the whole point of the partial unique index), so a restore
 * can legitimately fail. 23505 is caught here rather than pre-checked alone,
 * because a pre-check has a window: the address can be claimed between the
 * look and the write, and the index is the only thing that actually decides.
 */
async function restore(gymId, id) {
    try {
        const n = await (0, knex_1.db)('users')
            .where({ gym_id: gymId, id })
            .whereNotNull('deleted_at')
            .update({ deleted_at: null, deleted_by: null });
        return n ? 'restored' : 'already-active';
    }
    catch (err) {
        if (err.code === '23505')
            return 'email-taken';
        throw err;
    }
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