import { db } from '../db/knex';
import type { BillingCycle, PlatformSettings } from '../types';

/**
 * Cross-tenant queries for the platform super-admin. Nothing here is reachable
 * by gym accounts — the /admin routes are guarded by requirePlatformAdmin.
 */

export async function getSettings(): Promise<PlatformSettings> {
  const row = await db('platform_settings').first('trial_mode', 'trial_days');
  return row ?? { trial_mode: false, trial_days: 30 };
}

export async function updateSettings(patch: Partial<PlatformSettings>): Promise<PlatformSettings> {
  await db('platform_settings').update({ ...patch, updated_at: db.fn.now() });
  return getSettings();
}

export interface PlatformOverview {
  total_gyms: number;
  active_gyms: number;
  frozen_gyms: number;
  pending_gyms: number;
  trial_gyms: number;
  expiring_30d: number;
  expired_subs: number;
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

export interface GymListRow {
  id: number;
  name: string;
  address: string | null;
  phone: string | null;
  status: 'pending' | 'active' | 'frozen';
  frozen_at: string | null;
  admin_note: string | null;
  approved_at: string | null;
  subscription_ends_at: string | null;
  is_trial: boolean;
  /** Permanently exempt from the subscription paywall. */
  comped: boolean;
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

/** Approve a pending registration: active + paid year starting now. */
export async function approveGym(gymId: number): Promise<Date> {
  const ends = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  await db('gyms').where({ id: gymId }).update({
    status: 'active',
    approved_at: db.fn.now(),
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
export async function renewGym(
  gymId: number,
  cycle: BillingCycle = 'YEARLY',
  fromNow = false,
): Promise<Date> {
  // Both fragments are literals chosen here, never caller-supplied strings.
  const interval = cycle === 'MONTHLY' ? '1 month' : '1 year';
  const base = fromNow ? 'now()' : 'GREATEST(now(), COALESCE(subscription_ends_at, now()))';
  const { rows } = await db.raw(
    `
    UPDATE gyms
      SET subscription_ends_at = ${base} + interval '${interval}',
          is_trial = FALSE,
          approved_at = COALESCE(approved_at, now())
      WHERE id = ?
      RETURNING subscription_ends_at
  `,
    [gymId],
  );
  return rows[0].subscription_ends_at;
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
