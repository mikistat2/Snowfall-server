"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.create = create;
exports.findAllowedToday = findAllowedToday;
exports.countOpen = countOpen;
exports.listOpen = listOpen;
exports.findById = findById;
exports.findOpenByMember = findOpenByMember;
exports.checkout = checkout;
exports.autoCheckoutStale = autoCheckoutStale;
exports.autoCheckoutAllOpen = autoCheckoutAllOpen;
exports.listRecentByMember = listRecentByMember;
exports.countToday = countToday;
exports.lastCheckInPerMember = lastCheckInPerMember;
exports.peakHours = peakHours;
const knex_1 = require("../db/knex");
async function create(data, trx = knex_1.db) {
    const [row] = await trx('check_ins').insert(data).returning('*');
    return row;
}
/** First ALLOWED check-in for a member today (session-limit rule). */
async function findAllowedToday(memberId, now) {
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return (0, knex_1.db)('check_ins')
        .where({ member_id: memberId })
        .whereIn('decision', ['allowed', 'override'])
        .where('checked_in_at', '>=', startOfDay)
        .orderBy('checked_in_at', 'asc')
        .first();
}
async function countOpen(gymId) {
    const row = await (0, knex_1.db)('check_ins')
        .where({ gym_id: gymId })
        .whereNull('checked_out_at')
        .whereIn('decision', ['allowed', 'override'])
        .count('id as count')
        .first();
    return Number(row?.count ?? 0);
}
async function listOpen(gymId) {
    return (0, knex_1.db)('check_ins as c')
        .leftJoin('members as m', 'm.id', 'c.member_id')
        .leftJoin('guests as g', 'g.id', 'c.guest_id')
        .where('c.gym_id', gymId)
        .whereNull('c.checked_out_at')
        .whereIn('c.decision', ['allowed', 'override'])
        .select('c.*', 'm.full_name as member_name', 'g.name as guest_name')
        .orderBy('c.checked_in_at', 'desc');
}
async function findById(gymId, id) {
    return (0, knex_1.db)('check_ins').where({ gym_id: gymId, id }).first();
}
/** The member's current open session, if they are inside right now. */
async function findOpenByMember(memberId) {
    return (0, knex_1.db)('check_ins')
        .where({ member_id: memberId })
        .whereNull('checked_out_at')
        .whereIn('decision', ['allowed', 'override'])
        .orderBy('checked_in_at', 'desc')
        .first();
}
async function checkout(id, method, trx = knex_1.db) {
    const [row] = await trx('check_ins')
        .where({ id })
        .whereNull('checked_out_at')
        .update({ checked_out_at: trx.fn.now(), checkout_method: method })
        .returning('*');
    return row;
}
/**
 * Auto-close a gym's open sessions older than `hours`. Returns affected gym ids.
 *
 * Scoped to one gym on purpose. Without the `gym_id` filter this updated every
 * tenant's rows, so the first gym the job iterated applied *its*
 * auto_checkout_hours to everybody — a gym with a 3-hour rule silently got a
 * 12-hour one — and each of the N iterations re-scanned the whole table.
 */
async function autoCheckoutStale(gymId, hours) {
    return (0, knex_1.db)('check_ins')
        .where({ gym_id: gymId })
        .whereNull('checked_out_at')
        .where('checked_in_at', '<', new Date(Date.now() - hours * 60 * 60 * 1000))
        .update({ checked_out_at: knex_1.db.fn.now(), checkout_method: 'auto' })
        .returning('gym_id');
}
/**
 * Close everything still open for a gym in one statement (closing time).
 * Returns how many sessions were closed.
 */
async function autoCheckoutAllOpen(gymId) {
    const rows = await (0, knex_1.db)('check_ins')
        .where({ gym_id: gymId })
        .whereNull('checked_out_at')
        .whereIn('decision', ['allowed', 'override'])
        .update({ checked_out_at: knex_1.db.fn.now(), checkout_method: 'auto' })
        .returning('id');
    return rows.length;
}
async function listRecentByMember(memberId, limit = 30) {
    return (0, knex_1.db)('check_ins').where({ member_id: memberId }).orderBy('checked_in_at', 'desc').limit(limit);
}
async function countToday(gymId, now) {
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const row = await (0, knex_1.db)('check_ins')
        .where({ gym_id: gymId })
        .whereIn('decision', ['allowed', 'override'])
        .where('checked_in_at', '>=', startOfDay)
        .count('id as count')
        .first();
    return Number(row?.count ?? 0);
}
/** Last allowed check-in per member of a gym (absence nudges). */
async function lastCheckInPerMember(gymId) {
    const rows = (await (0, knex_1.db)('check_ins')
        .where({ gym_id: gymId })
        .whereNotNull('member_id')
        .whereIn('decision', ['allowed', 'override'])
        .select('member_id')
        .max('checked_in_at as last_at')
        .groupBy('member_id'));
    return new Map(rows.map((r) => [r.member_id, r.last_at]));
}
/** Check-ins per hour over the last N days (dashboard peak-hours chart). */
async function peakHours(gymId, days) {
    const rows = (await (0, knex_1.db)('check_ins')
        .where({ gym_id: gymId })
        .whereIn('decision', ['allowed', 'override'])
        .where('checked_in_at', '>=', new Date(Date.now() - days * 24 * 60 * 60 * 1000))
        .select(knex_1.db.raw('extract(hour from checked_in_at) as hour'))
        .count('id as count')
        .groupBy('hour')
        .orderBy('hour'));
    return rows.map((r) => ({ hour: Number(r.hour), count: Number(r.count) }));
}
//# sourceMappingURL=checkInModel.js.map