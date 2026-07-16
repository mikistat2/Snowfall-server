"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findByEmail = findByEmail;
exports.findById = findById;
exports.listByGym = listByGym;
exports.create = create;
exports.remove = remove;
exports.setLinkToken = setLinkToken;
exports.findByLinkToken = findByLinkToken;
exports.bindTelegram = bindTelegram;
exports.ownerChatIds = ownerChatIds;
const knex_1 = require("../db/knex");
async function findByEmail(email) {
    return (0, knex_1.db)('users').whereRaw('lower(email) = lower(?)', [email]).first();
}
async function findById(id) {
    return (0, knex_1.db)('users').where({ id }).first();
}
async function listByGym(gymId) {
    return (0, knex_1.db)('users')
        .where({ gym_id: gymId })
        .select('id', 'gym_id', 'name', 'phone', 'email', 'role', 'created_at')
        .orderBy('id');
}
async function create(data, trx = knex_1.db) {
    const [row] = await trx('users').insert(data).returning('*');
    return row;
}
async function remove(gymId, id) {
    return (0, knex_1.db)('users').where({ gym_id: gymId, id }).delete();
}
async function setLinkToken(gymId, userId, token) {
    await (0, knex_1.db)('users').where({ gym_id: gymId, id: userId }).update({ telegram_link_token: token });
}
async function findByLinkToken(token) {
    return (0, knex_1.db)('users').where({ telegram_link_token: token }).first();
}
async function bindTelegram(userId, chatId) {
    await (0, knex_1.db)('users').where({ id: userId }).update({ telegram_chat_id: chatId, telegram_link_token: null });
}
/** Owner chat ids for a gym (admin alerts / daily summary). */
async function ownerChatIds(gymId) {
    const rows = await (0, knex_1.db)('users')
        .where({ gym_id: gymId, role: 'owner' })
        .whereNotNull('telegram_chat_id')
        .select('telegram_chat_id');
    return rows.map((r) => Number(r.telegram_chat_id));
}
//# sourceMappingURL=userModel.js.map