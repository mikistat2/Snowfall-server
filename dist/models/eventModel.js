"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.create = create;
exports.listRecent = listRecent;
const knex_1 = require("../db/knex");
async function create(data, trx = knex_1.db) {
    const [row] = await trx('events').insert(data).returning('*');
    return row;
}
async function listRecent(gymId, limit = 50) {
    return (0, knex_1.db)('events').where({ gym_id: gymId }).orderBy('created_at', 'desc').limit(limit);
}
//# sourceMappingURL=eventModel.js.map