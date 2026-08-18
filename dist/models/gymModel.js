"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findById = findById;
exports.create = create;
exports.update = update;
exports.updateSettings = updateSettings;
exports.getSettings = getSettings;
exports.listAll = listAll;
exports.setComped = setComped;
const knex_1 = require("../db/knex");
const types_1 = require("../types");
async function findById(id, trx = knex_1.db) {
    return trx('gyms').where({ id }).first();
}
async function create(data, trx = knex_1.db) {
    const [row] = await trx('gyms')
        .insert({ ...data, settings: JSON.stringify(types_1.DEFAULT_SETTINGS) })
        .returning('*');
    return row;
}
async function update(id, data) {
    const [row] = await (0, knex_1.db)('gyms').where({ id }).update(data).returning('*');
    return row;
}
async function updateSettings(id, settings) {
    const [row] = await (0, knex_1.db)('gyms')
        .where({ id })
        .update({ settings: JSON.stringify(settings) })
        .returning('*');
    return row;
}
function getSettings(gym) {
    return { ...types_1.DEFAULT_SETTINGS, ...gym.settings };
}
async function listAll() {
    return (0, knex_1.db)('gyms').select('*');
}
/** Permanent exemption from the subscription paywall (see billingService.hasAccess). */
async function setComped(id, comped) {
    await (0, knex_1.db)('gyms').where({ id }).update({ comped });
}
//# sourceMappingURL=gymModel.js.map