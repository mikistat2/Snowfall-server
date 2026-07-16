"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listByGym = listByGym;
exports.findById = findById;
exports.create = create;
exports.update = update;
exports.isReferenced = isReferenced;
exports.hardDelete = hardDelete;
const knex_1 = require("../db/knex");
async function listByGym(gymId, activeOnly = false) {
    const q = (0, knex_1.db)('plans').where({ gym_id: gymId }).orderBy('id');
    if (activeOnly)
        q.andWhere({ active: true });
    return q;
}
async function findById(gymId, id) {
    return (0, knex_1.db)('plans').where({ gym_id: gymId, id }).first();
}
async function create(gymId, data) {
    const [row] = await (0, knex_1.db)('plans')
        .insert({ ...data, gym_id: gymId, includes: JSON.stringify(data.includes ?? {}) })
        .returning('*');
    return row;
}
async function update(gymId, id, data) {
    const patch = { ...data };
    if (data.includes !== undefined)
        patch.includes = JSON.stringify(data.includes);
    const [row] = await (0, knex_1.db)('plans').where({ gym_id: gymId, id }).update(patch).returning('*');
    return row;
}
async function isReferenced(id) {
    const row = await (0, knex_1.db)('subscriptions').where({ plan_id: id }).first('id');
    return !!row;
}
async function hardDelete(gymId, id) {
    return (0, knex_1.db)('plans').where({ gym_id: gymId, id }).delete();
}
//# sourceMappingURL=planModel.js.map