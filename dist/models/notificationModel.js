"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.create = create;
exports.list = list;
exports.lastForMember = lastForMember;
exports.countForMember = countForMember;
exports.sentToGymToday = sentToGymToday;
const knex_1 = require("../db/knex");
async function create(data) {
    const [row] = await (0, knex_1.db)('notifications')
        .insert({ ...data, channel: 'bot', payload: JSON.stringify(data.payload ?? {}) })
        .returning('*');
    return row;
}
async function list(gymId, filter = {}, limit = 200) {
    const q = (0, knex_1.db)('notifications as n')
        .leftJoin('members as m', 'm.id', 'n.member_id')
        .where('n.gym_id', gymId)
        .select('n.*', 'm.full_name as member_name')
        .orderBy('n.sent_at', 'desc')
        .limit(limit);
    if (filter.type)
        q.andWhere('n.type', filter.type);
    if (filter.status)
        q.andWhere('n.status', filter.status);
    return q;
}
/** Most recent notification of a type for a member (dedupe windows). */
async function lastForMember(memberId, type) {
    return (0, knex_1.db)('notifications')
        .where({ member_id: memberId, type })
        .whereIn('status', ['sent', 'failed', 'skipped_no_chat_id'])
        .orderBy('sent_at', 'desc')
        .first();
}
async function countForMember(memberId, type) {
    const row = await (0, knex_1.db)('notifications')
        .where({ member_id: memberId, type })
        .count('id as count')
        .first();
    return Number(row?.count ?? 0);
}
/** Has the gym already received this admin notification today? */
async function sentToGymToday(gymId, type, now) {
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const row = await (0, knex_1.db)('notifications')
        .where({ gym_id: gymId, type })
        .where('sent_at', '>=', startOfDay)
        .first('id');
    return !!row;
}
//# sourceMappingURL=notificationModel.js.map