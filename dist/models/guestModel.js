"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.create = create;
exports.findById = findById;
exports.listByGym = listByGym;
exports.listActiveDescriptors = listActiveDescriptors;
exports.expireNow = expireNow;
exports.setConvertedMember = setConvertedMember;
exports.purgeExpiredDescriptors = purgeExpiredDescriptors;
const knex_1 = require("../db/knex");
async function create(data, trx = knex_1.db) {
    const [row] = await trx('guests').insert(data).returning('*');
    return row;
}
async function findById(gymId, id) {
    return (0, knex_1.db)('guests').where({ gym_id: gymId, id }).first();
}
async function listByGym(gymId, limit = 100) {
    return (0, knex_1.db)('guests as g')
        .join('users as u', 'u.id', 'g.created_by')
        .leftJoin('members as m', 'm.id', 'g.converted_member_id')
        .where('g.gym_id', gymId)
        .select('g.*', 'u.name as created_by_name', 'm.full_name as converted_member_name')
        .orderBy('g.created_at', 'desc')
        .limit(limit);
}
/** Recognition cache: guests with a live pass and a stored descriptor. */
async function listActiveDescriptors(gymId) {
    const rows = await (0, knex_1.db)('guests')
        .where({ gym_id: gymId })
        .whereNotNull('descriptor')
        .where('valid_until', '>=', knex_1.db.fn.now())
        .select('*');
    return rows.map((g) => ({
        guest_id: g.id,
        name: g.name,
        valid_until: g.valid_until,
        descriptor: g.descriptor,
    }));
}
async function expireNow(gymId, id) {
    const [row] = await (0, knex_1.db)('guests')
        .where({ gym_id: gymId, id })
        .update({ valid_until: new Date(), descriptor: null })
        .returning('*');
    return row;
}
async function setConvertedMember(gymId, id, memberId) {
    await (0, knex_1.db)('guests').where({ gym_id: gymId, id }).update({ converted_member_id: memberId });
}
/** Cron: drop stored face data once the pass has expired (privacy). */
async function purgeExpiredDescriptors() {
    return (0, knex_1.db)('guests')
        .whereNotNull('descriptor')
        .where('valid_until', '<', knex_1.db.fn.now())
        .update({ descriptor: null });
}
//# sourceMappingURL=guestModel.js.map