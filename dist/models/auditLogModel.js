"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.list = list;
exports.log = log;
const knex_1 = require("../db/knex");
async function list(gymId, filter = {}, limit = 200) {
    const q = (0, knex_1.db)('audit_logs as a')
        .leftJoin('users as u', 'u.id', 'a.user_id')
        .where('a.gym_id', gymId)
        .select('a.*', 'u.name as user_name')
        .orderBy('a.created_at', 'desc')
        .limit(limit);
    if (filter.entity)
        q.andWhere('a.entity', filter.entity);
    if (filter.action)
        q.andWhereILike('a.action', `%${filter.action}%`);
    return q;
}
async function log(data, trx = knex_1.db) {
    await trx('audit_logs').insert({ ...data, meta: JSON.stringify(data.meta ?? {}) });
}
//# sourceMappingURL=auditLogModel.js.map