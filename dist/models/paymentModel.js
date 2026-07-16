"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.create = create;
exports.list = list;
exports.listByMember = listByMember;
exports.revenueSince = revenueSince;
const knex_1 = require("../db/knex");
async function create(data, trx = knex_1.db) {
    const [row] = await trx('payments').insert(data).returning('*');
    return row;
}
async function list(gymId, filter = {}, limit = 200) {
    const q = (0, knex_1.db)('payments as pay')
        .join('members as m', 'm.id', 'pay.member_id')
        .join('users as u', 'u.id', 'pay.marked_by')
        .where('pay.gym_id', gymId)
        .select('pay.*', 'm.full_name as member_name', 'u.name as marked_by_name')
        .orderBy('pay.created_at', 'desc')
        .limit(limit);
    if (filter.from)
        q.andWhere('pay.created_at', '>=', filter.from);
    if (filter.to)
        q.andWhere('pay.created_at', '<', `${filter.to}T23:59:59.999`);
    if (filter.method)
        q.andWhere('pay.method', filter.method);
    if (filter.member_id)
        q.andWhere('pay.member_id', filter.member_id);
    return q;
}
async function listByMember(memberId) {
    return (0, knex_1.db)('payments').where({ member_id: memberId }).orderBy('created_at', 'desc');
}
async function revenueSince(gymId, since) {
    const row = await (0, knex_1.db)('payments')
        .where({ gym_id: gymId })
        .where('created_at', '>=', since)
        .sum('amount as sum')
        .first();
    return Number(row?.sum ?? 0);
}
//# sourceMappingURL=paymentModel.js.map