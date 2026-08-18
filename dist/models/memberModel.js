"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listByGym = listByGym;
exports.exportByGym = exportByGym;
exports.findById = findById;
exports.create = create;
exports.update = update;
exports.setStatus = setStatus;
exports.setArchived = setArchived;
exports.paymentCount = paymentCount;
exports.hardDelete = hardDelete;
exports.listDescriptorsByGym = listDescriptorsByGym;
exports.addDescriptors = addDescriptors;
exports.clearDescriptors = clearDescriptors;
exports.setLinkToken = setLinkToken;
exports.findByLinkToken = findByLinkToken;
exports.bindTelegram = bindTelegram;
exports.descriptorCount = descriptorCount;
const knex_1 = require("../db/knex");
/**
 * `limit`/`offset` are optional: the desktop table asks for everything, the
 * mobile list pages through. Ordering is by name, which is stable, so paging
 * cannot skip or repeat a row between requests.
 */
async function listByGym(gymId, filter = {}) {
    const q = (0, knex_1.db)('members as m')
        .where('m.gym_id', gymId)
        // archived members are off the roster: they surface only when asked for by
        // name, from the Archived filter
        .modify((b) => (filter.archived ? b.whereNotNull('m.archived_at') : b.whereNull('m.archived_at')))
        .leftJoin((0, knex_1.db)('subscriptions')
        .select('member_id', 'plan_id', 'expires_at')
        .distinctOn('member_id')
        .orderBy(['member_id', { column: 'expires_at', order: 'desc' }])
        .as('s'), 's.member_id', 'm.id')
        .leftJoin('plans as p', 'p.id', 's.plan_id')
        .select('m.*', 'p.name as plan_name', 's.expires_at')
        .orderBy('m.full_name');
    if (filter.status)
        q.andWhere('m.status', filter.status);
    if (filter.search) {
        q.andWhere((b) => b.whereILike('m.full_name', `%${filter.search}%`).orWhereILike('m.phone', `%${filter.search}%`));
    }
    if (filter.limit != null)
        q.limit(filter.limit);
    if (filter.offset != null)
        q.offset(filter.offset);
    return q;
}
/** Full member data dump for the PDF export (one row per member). */
async function exportByGym(gymId) {
    const { rows } = await knex_1.db.raw(`
    SELECT
      m.id, m.full_name, m.phone, m.sex, m.status, m.joined_at,
      m.telegram_username,
      (m.telegram_chat_id IS NOT NULL)                             AS telegram_linked,
      p.name                                                       AS plan_name,
      s.starts_at, s.expires_at,
      COALESCE(pay.cnt, 0)::int                                    AS payments_count,
      COALESCE(pay.total, 0)::text                                 AS total_paid,
      pay.last_at                                                  AS last_payment_at,
      COALESCE(ci.cnt, 0)::int                                     AS checkins_count,
      ci.last_at                                                   AS last_checkin_at
    FROM members m
    LEFT JOIN LATERAL (
      SELECT plan_id, starts_at, expires_at FROM subscriptions
      WHERE member_id = m.id ORDER BY expires_at DESC LIMIT 1
    ) s ON TRUE
    LEFT JOIN plans p ON p.id = s.plan_id
    LEFT JOIN LATERAL (
      SELECT count(*) AS cnt, sum(amount) AS total, max(created_at) AS last_at
      FROM payments WHERE member_id = m.id
    ) pay ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*) AS cnt, max(checked_in_at) AS last_at
      FROM check_ins WHERE member_id = m.id
    ) ci ON TRUE
    WHERE m.gym_id = ? AND m.archived_at IS NULL
    ORDER BY m.full_name
  `, [gymId]);
    return rows;
}
async function findById(gymId, id, trx = knex_1.db) {
    return trx('members').where({ gym_id: gymId, id }).first();
}
/**
 * `joined_at` defaults to now() in the schema and is only ever passed when
 * back-filling a member who joined before the system was installed.
 */
async function create(gymId, data, trx = knex_1.db) {
    const [row] = await trx('members').insert({ ...data, gym_id: gymId }).returning('*');
    return row;
}
async function update(gymId, id, data, trx = knex_1.db) {
    const [row] = await trx('members').where({ gym_id: gymId, id }).update(data).returning('*');
    return row;
}
async function setStatus(id, status, trx = knex_1.db) {
    await trx('members').where({ id }).update({ status });
}
async function setArchived(gymId, id, archived, trx = knex_1.db) {
    const [row] = await trx('members')
        .where({ gym_id: gymId, id })
        .update({ archived_at: archived ? new Date() : null })
        .returning('*');
    return row;
}
/** How many payments reference this member — the test for "can this be deleted?". */
async function paymentCount(memberId, trx = knex_1.db) {
    const row = await trx('payments').where({ member_id: memberId }).count('id as count').first();
    return Number(row?.count ?? 0);
}
/**
 * Permanent removal. Subscriptions, face descriptors, check-ins and
 * notifications are ON DELETE CASCADE; guests.converted_member_id is not, so
 * that pointer is cleared first (the guest's own record is history and stays).
 *
 * Callers must have established that the member has no payments — the payments
 * FK would refuse anyway, but with a constraint error instead of an explanation.
 */
async function hardDelete(gymId, id, trx = knex_1.db) {
    await trx('guests').where({ converted_member_id: id }).update({ converted_member_id: null });
    await trx('members').where({ gym_id: gymId, id }).delete();
}
/** All descriptors for a gym's non-expired-beyond-recognition members (monitor cache). */
async function listDescriptorsByGym(gymId) {
    const rows = await (0, knex_1.db)('face_descriptors as fd')
        .join('members as m', 'm.id', 'fd.member_id')
        .where('m.gym_id', gymId)
        // an archived member must not be recognised at the door
        .whereNull('m.archived_at')
        .select('fd.member_id', 'm.full_name', 'm.status', 'fd.descriptor');
    const byMember = new Map();
    for (const r of rows) {
        const entry = byMember.get(r.member_id) ?? {
            member_id: r.member_id,
            full_name: r.full_name,
            status: r.status,
            descriptors: [],
        };
        entry.descriptors.push(r.descriptor);
        byMember.set(r.member_id, entry);
    }
    return [...byMember.values()];
}
async function addDescriptors(memberId, descriptors, trx = knex_1.db) {
    await trx('face_descriptors').insert(descriptors.map((d) => ({ member_id: memberId, descriptor: d })));
}
async function clearDescriptors(memberId, trx = knex_1.db) {
    await trx('face_descriptors').where({ member_id: memberId }).delete();
}
async function setLinkToken(gymId, memberId, token) {
    await (0, knex_1.db)('members').where({ gym_id: gymId, id: memberId }).update({ telegram_link_token: token });
}
async function findByLinkToken(token) {
    return (0, knex_1.db)('members').where({ telegram_link_token: token }).first();
}
async function bindTelegram(memberId, chatId, username) {
    await (0, knex_1.db)('members')
        .where({ id: memberId })
        .update({ telegram_chat_id: chatId, telegram_username: username, telegram_link_token: null });
}
async function descriptorCount(memberId) {
    const row = await (0, knex_1.db)('face_descriptors').where({ member_id: memberId }).count('id as count').first();
    return Number(row?.count ?? 0);
}
//# sourceMappingURL=memberModel.js.map