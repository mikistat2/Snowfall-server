import { db } from '../db/knex';

/**
 * Cross-tenant queries for the platform super-admin. Nothing here is reachable
 * by gym accounts — the /admin routes are guarded by requirePlatformAdmin.
 */

export interface PlatformOverview {
  total_gyms: number;
  active_gyms: number;
  frozen_gyms: number;
  new_gyms_30d: number;
  total_members: number;
  total_staff: number;
  checkins_7d: number;
  revenue_total: string;
  revenue_30d: string;
}

export async function overview(): Promise<PlatformOverview> {
  const { rows } = await db.raw(`
    SELECT
      (SELECT count(*)::int FROM gyms)                                             AS total_gyms,
      (SELECT count(*)::int FROM gyms WHERE status = 'active')                     AS active_gyms,
      (SELECT count(*)::int FROM gyms WHERE status = 'frozen')                     AS frozen_gyms,
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

export interface GymListRow {
  id: number;
  name: string;
  address: string | null;
  phone: string | null;
  status: 'active' | 'frozen';
  frozen_at: string | null;
  admin_note: string | null;
  created_at: string;
  owner_name: string | null;
  owner_email: string | null;
  owner_phone: string | null;
  staff_count: number;
  member_count: number;
  active_member_count: number;
  revenue_total: string;
  revenue_30d: string;
  last_checkin_at: string | null;
}

export async function listGyms(search?: string): Promise<GymListRow[]> {
  const params: string[] = [];
  let where = '';
  if (search && search.trim()) {
    const like = `%${search.trim()}%`;
    where = `WHERE g.name ILIKE ? OR o.email ILIKE ? OR o.name ILIKE ?`;
    params.push(like, like, like);
  }
  const { rows } = await db.raw(
    `
    SELECT
      g.id, g.name, g.address, g.phone, g.status, g.frozen_at, g.admin_note, g.created_at,
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
  `,
    params,
  );
  return rows;
}

export interface GymStaffRow {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  role: 'owner' | 'staff';
  created_at: string;
}

export async function gymStaff(gymId: number): Promise<GymStaffRow[]> {
  return db('users')
    .where({ gym_id: gymId })
    .select('id', 'name', 'email', 'phone', 'role', 'created_at')
    .orderBy('id');
}

export async function setStatus(gymId: number, status: 'active' | 'frozen', note?: string | null): Promise<void> {
  const patch: Record<string, unknown> = {
    status,
    frozen_at: status === 'frozen' ? db.fn.now() : null,
  };
  if (note !== undefined) patch.admin_note = note;
  await db('gyms').where({ id: gymId }).update(patch);
}

export async function setNote(gymId: number, note: string | null): Promise<void> {
  await db('gyms').where({ id: gymId }).update({ admin_note: note });
}

/** Revoke every refresh token of a gym's staff — used when freezing. */
export async function revokeGymSessions(gymId: number): Promise<void> {
  await db('refresh_tokens')
    .whereIn('user_id', db('users').select('id').where({ gym_id: gymId }))
    .whereNull('revoked_at')
    .update({ revoked_at: db.fn.now() });
}

/**
 * Permanently delete a tenant and all its data. Payments carry an
 * immutability trigger (audit trail), so it is disabled for the duration of
 * the transaction — every other table cascades from gyms.
 */
export async function deleteGym(gymId: number): Promise<void> {
  await db.transaction(async (trx) => {
    await trx.raw('ALTER TABLE payments DISABLE TRIGGER payments_immutable');
    await trx('gyms').where({ id: gymId }).delete();
    await trx.raw('ALTER TABLE payments ENABLE TRIGGER payments_immutable');
  });
}
