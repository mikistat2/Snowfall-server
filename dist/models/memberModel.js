"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listByGym = listByGym;
exports.findById = findById;
exports.create = create;
exports.update = update;
exports.setStatus = setStatus;
exports.listDescriptorsByGym = listDescriptorsByGym;
exports.addDescriptors = addDescriptors;
exports.clearDescriptors = clearDescriptors;
exports.setLinkToken = setLinkToken;
exports.findByLinkToken = findByLinkToken;
exports.bindTelegram = bindTelegram;
exports.descriptorCount = descriptorCount;
const knex_1 = require("../db/knex");
async function listByGym(gymId, filter = {}) {
    const q = (0, knex_1.db)('members as m')
        .where('m.gym_id', gymId)
        .leftJoin((0, knex_1.db)('subscriptions')
        .select('member_id', 'plan_id', 'expires_at')
        .distinctOn('member_id')
        .orderBy(['member_id', { column: 'expires_at', order: 'desc' }])
        .as('s'), 's.member_id', 'm.id')
        .leftJoin('plans as p', 'p.id', 's.plan_id')
        .select('m.*', 'p.name as plan_name', 's.expires_at')
        .orderBy('m.full_name');
    if (filter.status)
        q.andWhere('m.status', filter.status);
    if (filter.search) {
        q.andWhere((b) => b.whereILike('m.full_name', `%${filter.search}%`).orWhereILike('m.phone', `%${filter.search}%`));
    }
    return q;
}
async function findById(gymId, id, trx = knex_1.db) {
    return trx('members').where({ gym_id: gymId, id }).first();
}
async function create(gymId, data, trx = knex_1.db) {
    const [row] = await trx('members').insert({ ...data, gym_id: gymId }).returning('*');
    return row;
}
async function update(gymId, id, data, trx = knex_1.db) {
    const [row] = await trx('members').where({ gym_id: gymId, id }).update(data).returning('*');
    return row;
}
async function setStatus(id, status, trx = knex_1.db) {
    await trx('members').where({ id }).update({ status });
}
/** All descriptors for a gym's non-expired-beyond-recognition members (monitor cache). */
async function listDescriptorsByGym(gymId) {
    const rows = await (0, knex_1.db)('face_descriptors as fd')
        .join('members as m', 'm.id', 'fd.member_id')
        .where('m.gym_id', gymId)
        .select('fd.member_id', 'm.full_name', 'm.status', 'fd.descriptor');
    const byMember = new Map();
    for (const r of rows) {
        const entry = byMember.get(r.member_id) ?? {
            member_id: r.member_id,
            full_name: r.full_name,
            status: r.status,
            descriptors: [],
        };
        entry.descriptors.push(r.descriptor);
        byMember.set(r.member_id, entry);
    }
    return [...byMember.values()];
}
async function addDescriptors(memberId, descriptors, trx = knex_1.db) {
    await trx('face_descriptors').insert(descriptors.map((d) => ({ member_id: memberId, descriptor: d })));
}
async function clearDescriptors(memberId, trx = knex_1.db) {
    await trx('face_descriptors').where({ member_id: memberId }).delete();
}
async function setLinkToken(gymId, memberId, token) {
    await (0, knex_1.db)('members').where({ gym_id: gymId, id: memberId }).update({ telegram_link_token: token });
}
async function findByLinkToken(token) {
    return (0, knex_1.db)('members').where({ telegram_link_token: token }).first();
}
async function bindTelegram(memberId, chatId, username) {
    await (0, knex_1.db)('members')
        .where({ id: memberId })
        .update({ telegram_chat_id: chatId, telegram_username: username, telegram_link_token: null });
}
async function descriptorCount(memberId) {
    const row = await (0, knex_1.db)('face_descriptors').where({ member_id: memberId }).count('id as count').first();
    return Number(row?.count ?? 0);
}
//# sourceMappingURL=memberModel.js.map