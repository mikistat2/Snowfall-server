"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.create = create;
exports.listRecent = listRecent;
exports.purgeOlderThan = purgeOlderThan;
const knex_1 = require("../db/knex");
async function create(data, trx = knex_1.db) {
    const [row] = await trx('events').insert(data).returning('*');
    return row;
}
async function listRecent(gymId, limit = 50) {
    return (0, knex_1.db)('events').where({ gym_id: gymId }).orderBy('created_at', 'desc').limit(limit);
}
/** Rows per DELETE statement, so a first prune of a year's backlog never
 *  holds one long transaction on a 0.25 CU compute. */
const PURGE_BATCH = 5_000;
/**
 * Retention prune (daily job).
 *
 * `listRecent` above is the ONLY read of this table, and it serves the newest
 * 50 rows per gym. Anything older is unreachable from the UI and exists purely
 * to consume the 0.5 GB of free-tier storage — this table is the single
 * biggest contributor to per-gym growth (~4.8 MB/gym/year).
 *
 * Deleted in batches, newest-cutoff first, so the statement stays short.
 */
async function purgeOlderThan(days) {
    let total = 0;
    for (;;) {
        const deleted = await (0, knex_1.db)('events')
            .whereIn('id', (0, knex_1.db)('events')
            .select('id')
            .where('created_at', '<', knex_1.db.raw("now() - ? * interval '1 day'", [days]))
            .limit(PURGE_BATCH))
            .del();
        total += deleted;
        if (deleted < PURGE_BATCH)
            return total;
    }
}
//# sourceMappingURL=eventModel.js.map