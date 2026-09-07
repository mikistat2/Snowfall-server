"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.REMINDER_MILESTONES = void 0;
exports.findLatestByMember = findLatestByMember;
exports.listByMember = listByMember;
exports.create = create;
exports.update = update;
exports.findCurrentWithPlan = findCurrentWithPlan;
exports.listLatestWithMemberForGym = listLatestWithMemberForGym;
exports.listLatestForGym = listLatestForGym;
exports.listReminderCandidates = listReminderCandidates;
exports.markReminded = markReminded;
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
// ------------------------------------------------------- expiry reminders --
/** The three points in a period a member can be messaged about, in order. */
exports.REMINDER_MILESTONES = ['ahead', 'due', 'grace'];
const MILESTONE_COLUMN = {
    ahead: 'reminded_ahead_at',
    due: 'reminded_due_at',
    grace: 'reminded_grace_at',
};
/**
 * Members whose latest subscription is close enough to its end to be worth a
 * message, from `aheadDays` before expiry to `catchUpDays` after it.
 *
 * The "latest per member" step happens BEFORE the date window, not after. The
 * other way round looks equivalent and is not: a member who renewed early has
 * both an old expiring row and a new distant one, and filtering first would
 * drop the new row out of the window and leave DISTINCT ON to pick the old
 * one — telling somebody who has just paid that their membership has run out.
 *
 * The trailing edge is what makes a first deploy safe: members who lapsed
 * months ago are excluded in SQL, so switching catch-up on cannot dredge up a
 * backlog of ancient expiries.
 */
async function listReminderCandidates(gymId, aheadDays, catchUpDays) {
    const latest = (0, knex_1.db)('subscriptions as s')
        .distinctOn('s.member_id')
        .where('s.gym_id', gymId)
        .select('s.*')
        .orderBy(['s.member_id', { column: 's.expires_at', order: 'desc' }]);
    return knex_1.db
        .from(latest.as('l'))
        .join('members as m', 'm.id', 'l.member_id')
        .whereNull('m.archived_at') // no reminders to someone who left the gym
        .whereNot('l.status', 'frozen')
        .whereRaw('l.expires_at >= (now()::date - ?::int)', [catchUpDays])
        .whereRaw('l.expires_at <= (now()::date + ?::int)', [aheadDays])
        .select('l.id as subscription_id', 'l.member_id', 'l.expires_at', 'l.reminded_ahead_at', 'l.reminded_due_at', 'l.reminded_grace_at', 'm.full_name', 'm.telegram_chat_id');
}
/**
 * Stamps every milestone up to and including `milestone`.
 *
 * The ones being skipped matter as much as the one just sent. A member the
 * server was asleep for is three messages behind; they should get today's
 * truth once, not a backlog of three. Closing the earlier milestones is what
 * stops tomorrow's run from delivering yesterday's news.
 *
 * COALESCE keeps whatever was already there, so a re-run never rewrites the
 * date a message actually went out.
 */
async function markReminded(subscriptionId, milestone, at) {
    const upTo = exports.REMINDER_MILESTONES.slice(0, exports.REMINDER_MILESTONES.indexOf(milestone) + 1);
    const patch = {};
    for (const m of upTo) {
        const column = MILESTONE_COLUMN[m];
        patch[column] = knex_1.db.raw('COALESCE(??, ?)', [column, at]);
    }
    await (0, knex_1.db)('subscriptions').where({ id: subscriptionId }).update(patch);
}
//# sourceMappingURL=subscriptionModel.js.map