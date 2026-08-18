"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findLatestByMember = findLatestByMember;
exports.listByMember = listByMember;
exports.create = create;
exports.update = update;
exports.findCurrentWithPlan = findCurrentWithPlan;
exports.listLatestWithMemberForGym = listLatestWithMemberForGym;
exports.listLatestForGym = listLatestForGym;
const knex_1 = require("../db/knex");
/** Latest subscription (by expiry) for a member. */
async function findLatestByMember(memberId, trx = knex_1.db) {
    return trx('subscriptions').where({ member_id: memberId }).orderBy('expires_at', 'desc').first();
}
async function listByMember(memberId) {
    return (0, knex_1.db)('subscriptions as s')
        .join('plans as p', 'p.id', 's.plan_id')
        .where('s.member_id', memberId)
        .select('s.*', 'p.name as plan_name')
        .orderBy('s.expires_at', 'desc');
}
async function create(data, trx = knex_1.db) {
    const [row] = await trx('subscriptions').insert(data).returning('*');
    return row;
}
async function update(id, patch, trx = knex_1.db) {
    const [row] = await trx('subscriptions').where({ id }).update(patch).returning('*');
    return row;
}
/** Latest subscription + plan for the check-in decision. */
async function findCurrentWithPlan(memberId) {
    return (0, knex_1.db)('subscriptions as s')
        .join('plans as p', 'p.id', 's.plan_id')
        .where('s.member_id', memberId)
        .select('s.*', 'p.name as plan_name', 'p.sessions_per_day', 'p.allowed_hours', 'p.duration_days')
        .orderBy('s.expires_at', 'desc')
        .first();
}
/** Latest subscription per member with member contact info (reminder cron). */
async function listLatestWithMemberForGym(gymId) {
    return (0, knex_1.db)('subscriptions as s')
        .distinctOn('s.member_id')
        .join('members as m', 'm.id', 's.member_id')
        .where('s.gym_id', gymId)
        .whereNull('m.archived_at') // no reminders to someone who left the gym
        .select('s.member_id', 'm.full_name', 'm.telegram_chat_id', 'm.status as member_status', 's.expires_at', 's.status as sub_status')
        .orderBy(['s.member_id', { column: 's.expires_at', order: 'desc' }]);
}
/** All non-frozen members of a gym with their latest subscription (for status recompute). */
async function listLatestForGym(gymId) {
    return (0, knex_1.db)('subscriptions as s')
        .distinctOn('s.member_id')
        .join('members as m', 'm.id', 's.member_id')
        .where('s.gym_id', gymId)
        .whereNull('m.archived_at') // frozen in time until restored
        .select('s.member_id', 'm.status as member_status', 's.id as subscription_id', 's.expires_at', 's.status as sub_status')
        .orderBy(['s.member_id', { column: 's.expires_at', order: 'desc' }]);
}
//# sourceMappingURL=subscriptionModel.js.map