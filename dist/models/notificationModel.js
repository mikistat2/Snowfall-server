"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.create = create;
exports.list = list;
exports.purgeOlderThan = purgeOlderThan;
exports.lastForMember = lastForMember;
exports.sentToGymToday = sentToGymToday;
const knex_1 = require("../db/knex");
async function create(data) {
    const [row] = await (0, knex_1.db)('notifications')
        .insert({ ...data, channel: 'bot', payload: JSON.stringify(data.payload ?? {}) })
        .returning('*');
    return row;
}
/**
 * Newest first, one page at a time. See auditLogModel.list — the `id`
 * tiebreaker and the count-without-the-join apply here for the same reasons,
 * and matter more: a single 09:00 reminder pass writes a whole gym's rows
 * inside the same second.
 */
async function list(gymId, filter = {}) {
    const page = Math.max(1, filter.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, filter.pageSize ?? 25));
    const base = (0, knex_1.db)('notifications as n').where('n.gym_id', gymId);
    if (filter.type)
        base.andWhere('n.type', filter.type);
    if (filter.status)
        base.andWhere('n.status', filter.status);
    const [countRow] = await base.clone().count('n.id as count');
    const total = Number(countRow?.count ?? 0);
    const rows = await base
        .clone()
        .leftJoin('members as m', 'm.id', 'n.member_id')
        .select('n.*', 'm.full_name as member_name')
        .orderBy([
        { column: 'n.sent_at', order: 'desc' },
        { column: 'n.id', order: 'desc' },
    ])
        .limit(pageSize)
        .offset((page - 1) * pageSize);
    return { rows, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}
/** See eventModel.PURGE_BATCH — same reasoning. */
const PURGE_BATCH = 5_000;
/**
 * Retention prune (daily job).
 *
 * `list` above is the only read that reaches the UI and it serves the newest
 * 200 rows per gym, unpaginated. The rest of this table is written by every
 * Telegram send attempt — one row per member per reminder, per nudge, per
 * receipt — which made it the last append-only table growing without bound.
 *
 * The dedupe reads below (`lastForMember`, `sentToGymToday`) look back hours
 * or a few days, so a one-week window leaves them intact. The absence nudge's
 * template rotation used to count rows here and no longer does; it reads
 * `members.absence_nudge_count`, which retention cannot reach.
 */
async function purgeOlderThan(days) {
    let total = 0;
    for (;;) {
        const deleted = await (0, knex_1.db)('notifications')
            .whereIn('id', (0, knex_1.db)('notifications')
            .select('id')
            .where('sent_at', '<', knex_1.db.raw("now() - ? * interval '1 day'", [days]))
            .limit(PURGE_BATCH))
            .del();
        total += deleted;
        if (deleted < PURGE_BATCH)
            return total;
    }
}
/** Most recent notification of a type for a member (dedupe windows). */
async function lastForMember(memberId, type) {
    return (0, knex_1.db)('notifications')
        .where({ member_id: memberId, type })
        .whereIn('status', ['sent', 'failed', 'skipped_no_chat_id'])
        .orderBy('sent_at', 'desc')
        .first();
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