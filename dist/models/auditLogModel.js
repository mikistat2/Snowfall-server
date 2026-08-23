"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.list = list;
exports.purgeOlderThan = purgeOlderThan;
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
/** See eventModel.PURGE_BATCH — same reasoning. */
const PURGE_BATCH = 5_000;
/**
 * Retention prune (daily job).
 *
 * `list` above serves at most the newest 200 rows per gym and has no
 * pagination, so older rows cannot be displayed. The window is kept long
 * (a year) anyway: audit rows answer "who changed this member", and that is
 * worth more than the ~1.4 MB/gym/year it costs.
 */
async function purgeOlderThan(days) {
    let total = 0;
    for (;;) {
        const deleted = await (0, knex_1.db)('audit_logs')
            .whereIn('id', (0, knex_1.db)('audit_logs')
            .select('id')
            .where('created_at', '<', knex_1.db.raw("now() - ? * interval '1 day'", [days]))
            .limit(PURGE_BATCH))
            .del();
        total += deleted;
        if (deleted < PURGE_BATCH)
            return total;
    }
}
async function log(data, trx = knex_1.db) {
    await trx('audit_logs').insert({ ...data, meta: JSON.stringify(data.meta ?? {}) });
}
//# sourceMappingURL=auditLogModel.js.map