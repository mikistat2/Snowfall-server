"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSettings = getSettings;
exports.updateSettings = updateSettings;
exports.overview = overview;
exports.listGyms = listGyms;
exports.gymStaff = gymStaff;
exports.setStatus = setStatus;
exports.setNote = setNote;
exports.approveGym = approveGym;
exports.renewGym = renewGym;
exports.revokeGymSessions = revokeGymSessions;
exports.deleteGym = deleteGym;
const knex_1 = require("../db/knex");
/**
 * Cross-tenant queries for the platform super-admin. Nothing here is reachable
 * by gym accounts — the /admin routes are guarded by requirePlatformAdmin.
 */
async function getSettings() {
    const row = await (0, knex_1.db)('platform_settings').first('trial_mode', 'trial_days');
    return row ?? { trial_mode: false, trial_days: 30 };
}
async function updateSettings(patch) {
    await (0, knex_1.db)('platform_settings').update({ ...patch, updated_at: knex_1.db.fn.now() });
    return getSettings();
}
async function overview() {
    const { rows } = await knex_1.db.raw(`
    SELECT
      (SELECT count(*)::int FROM gyms)                                             AS total_gyms,
      (SELECT count(*)::int FROM gyms WHERE status = 'active')                     AS active_gyms,
      (SELECT count(*)::int FROM gyms WHERE status = 'frozen')                     AS frozen_gyms,
      (SELECT count(*)::int FROM gyms WHERE status = 'pending')                    AS pending_gyms,
      (SELECT count(*)::int FROM gyms WHERE status = 'active' AND is_trial)        AS trial_gyms,
      (SELECT count(*)::int FROM gyms
        WHERE status = 'active' AND subscription_ends_at IS NOT NULL
          AND subscription_ends_at BETWEEN now() AND now() + interval '30 days')   AS expiring_30d,
      (SELECT count(*)::int FROM gyms
        WHERE status = 'active' AND subscription_ends_at < now())                  AS expired_subs,
      (SELECT count(*)::int FROM gyms WHERE created_at > now() - interval '30 days') AS new_gyms_30d,
      (SELECT count(*)::int FROM members)                                          AS total_members,
      (SELECT count(*)::int FROM users)                                            AS total_staff,
      (SELECT count(*)::int FROM check_ins
        WHERE checked_in_at > now() - interval '7 days')                           AS checkins_7d,
      (SELECT COALESCE(sum(amount), 0)::text FROM payments)                        AS revenue_total,
      (SELECT COALESCE(sum(amount), 0)::text FROM payments
        WHERE created_at > now() - interval '30 days')                             AS revenue_30d
  `);
    return rows[0];
}
async function listGyms(search) {
    const params = [];
    let where = '';
    if (search && search.trim()) {
        const like = `%${search.trim()}%`;
        where = `WHERE g.name ILIKE ? OR o.email ILIKE ? OR o.name ILIKE ?`;
        params.push(like, like, like);
    }
    const { rows } = await knex_1.db.raw(`
    SELECT
      g.id, g.name, g.address, g.phone, g.status, g.frozen_at, g.admin_note,
      g.approved_at, g.subscription_ends_at, g.is_trial, g.comped, g.created_at,
      o.name  AS owner_name,
      o.email AS owner_email,
      o.phone AS owner_phone,
      (SELECT count(*)::int FROM users u WHERE u.gym_id = g.id)                       AS staff_count,
      (SELECT count(*)::int FROM members m WHERE m.gym_id = g.id)                     AS member_count,
      (SELECT count(*)::int FROM members m
        WHERE m.gym_id = g.id AND m.status IN ('active', 'expiring', 'grace'))        AS active_member_count,
      (SELECT COALESCE(sum(p.amount), 0)::text FROM payments p WHERE p.gym_id = g.id) AS revenue_total,
      (SELECT COALESCE(sum(p.amount), 0)::text FROM payments p
        WHERE p.gym_id = g.id AND p.created_at > now() - interval '30 days')          AS revenue_30d,
      (SELECT max(c.checked_in_at) FROM check_ins c WHERE c.gym_id = g.id)            AS last_checkin_at
    FROM gyms g
    LEFT JOIN LATERAL (
      SELECT u.name, u.email, u.phone FROM users u
      WHERE u.gym_id = g.id AND u.role = 'owner'
      ORDER BY u.id ASC LIMIT 1
    ) o ON TRUE
    ${where}
    ORDER BY g.created_at DESC
  `, params);
    return rows;
}
async function gymStaff(gymId) {
    return (0, knex_1.db)('users')
        .where({ gym_id: gymId })
        .select('id', 'name', 'email', 'phone', 'role', 'created_at')
        .orderBy('id');
}
async function setStatus(gymId, status, note) {
    const patch = {
        status,
        frozen_at: status === 'frozen' ? knex_1.db.fn.now() : null,
    };
    if (note !== undefined)
        patch.admin_note = note;
    await (0, knex_1.db)('gyms').where({ id: gymId }).update(patch);
}
async function setNote(gymId, note) {
    await (0, knex_1.db)('gyms').where({ id: gymId }).update({ admin_note: note });
}
/** Approve a pending registration: active + paid year starting now. */
async function approveGym(gymId) {
    const ends = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    await (0, knex_1.db)('gyms').where({ id: gymId }).update({
        status: 'active',
        approved_at: knex_1.db.fn.now(),
        subscription_ends_at: ends,
        is_trial: false,
    });
    return ends;
}
/**
 * Extend the subscription by one month or one year.
 *
 * By default the new period stacks on whatever time is left, which is what a
 * renewal means. `fromNow` drops that remainder and starts the paid period
 * today — used when converting a free trial, where the leftover trial days
 * were never paid for.
 */
async function renewGym(gymId, cycle = 'YEARLY', fromNow = false) {
    // Both fragments are literals chosen here, never caller-supplied strings.
    const interval = cycle === 'MONTHLY' ? '1 month' : '1 year';
    const base = fromNow ? 'now()' : 'GREATEST(now(), COALESCE(subscription_ends_at, now()))';
    const { rows } = await knex_1.db.raw(`
    UPDATE gyms
      SET subscription_ends_at = ${base} + interval '${interval}',
          is_trial = FALSE,
          approved_at = COALESCE(approved_at, now())
      WHERE id = ?
      RETURNING subscription_ends_at
  `, [gymId]);
    return rows[0].subscription_ends_at;
}
/** Revoke every refresh token of a gym's staff — used when freezing. */
async function revokeGymSessions(gymId) {
    await (0, knex_1.db)('refresh_tokens')
        .whereIn('user_id', (0, knex_1.db)('users').select('id').where({ gym_id: gymId }))
        .whereNull('revoked_at')
        .update({ revoked_at: knex_1.db.fn.now() });
}
/**
 * Permanently delete a tenant and all its data. Payments carry an
 * immutability trigger (audit trail), so it is disabled for the duration of
 * the transaction — every other table cascades from gyms.
 */
async function deleteGym(gymId) {
    await knex_1.db.transaction(async (trx) => {
        await trx.raw('ALTER TABLE payments DISABLE TRIGGER payments_immutable');
        await trx('gyms').where({ id: gymId }).delete();
        await trx.raw('ALTER TABLE payments ENABLE TRIGGER payments_immutable');
    });
}
//# sourceMappingURL=platformModel.js.map