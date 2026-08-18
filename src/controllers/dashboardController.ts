import type { Request, Response } from 'express';
import { db } from '../db/knex';
import * as checkInModel from '../models/checkInModel';
import * as paymentModel from '../models/paymentModel';
import * as occupancyService from '../services/occupancyService';

export async function stats(req: Request, res: Response): Promise<void> {
  const gymId = req.auth.gymId;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const in7days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const [checkInsToday, occupancy, revenueThisMonth, expiringSoonRow, memberCounts, peakHours] =
    await Promise.all([
      checkInModel.countToday(gymId, now),
      occupancyService.getOccupancy(gymId),
      paymentModel.revenueSince(gymId, startOfMonth),
      db('subscriptions as s')
        .join('members as m', 'm.id', 's.member_id')
        .where('s.gym_id', gymId)
        .whereNull('m.archived_at')
        .whereNot('s.status', 'frozen')
        .whereBetween('s.expires_at', [now, in7days])
        .countDistinct<{ count: string }>('s.member_id as count')
        .first(),
      db('members')
        .where({ gym_id: gymId })
        .whereNull('archived_at')
        .select('status')
        .count('id as count')
        .groupBy('status'),
      checkInModel.peakHours(gymId, 14),
    ]);

  res.json({
    check_ins_today: checkInsToday,
    occupancy,
    revenue_this_month: revenueThisMonth,
    expiring_in_7_days: Number(expiringSoonRow?.count ?? 0),
    members_by_status: Object.fromEntries(
      (memberCounts as { status: string; count: string }[]).map((r) => [r.status, Number(r.count)]),
    ),
    peak_hours: peakHours,
  });
}

/**
 * "Today" digest for the sidebar page: everything that happened today (new
 * members, payments, check-ins, guest passes) plus who is about to expire in
 * the next 7 days and who just expired in the last 7 — actionable follow-ups.
 */
export async function today(req: Request, res: Response): Promise<void> {
  const gymId = req.auth.gymId;
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const [newMembers, expiring, payments, checkInRow, occupancy, guestRow] = await Promise.all([
    db.raw(
      `
      SELECT m.id, m.full_name, m.phone, m.created_at, p.name AS plan_name
      FROM members m
      LEFT JOIN LATERAL (
        SELECT pl.name FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id
        WHERE s.member_id = m.id ORDER BY s.created_at DESC LIMIT 1
      ) p ON TRUE
      WHERE m.gym_id = ? AND m.created_at >= ? AND m.archived_at IS NULL
      ORDER BY m.created_at DESC
    `,
      [gymId, startOfDay],
    ),
    // latest subscription per member, within ±7 days of today (negative
    // days_left = just expired; the client splits the two groups)
    db.raw(
      `
      WITH latest AS (
        SELECT DISTINCT ON (s.member_id) s.member_id, s.expires_at
        FROM subscriptions s
        WHERE s.gym_id = ?
        ORDER BY s.member_id, s.expires_at DESC
      )
      SELECT m.id, m.full_name, m.phone, m.status, l.expires_at,
             (l.expires_at - CURRENT_DATE)::int AS days_left
      FROM latest l
      JOIN members m ON m.id = l.member_id
      WHERE m.status <> 'frozen'
        AND m.archived_at IS NULL
        AND l.expires_at BETWEEN CURRENT_DATE - 7 AND CURRENT_DATE + 7
      ORDER BY l.expires_at, m.full_name
    `,
      [gymId],
    ),
    db.raw(
      `
      SELECT p.id, p.amount, p.method, p.created_at, m.full_name AS member_name
      FROM payments p JOIN members m ON m.id = p.member_id
      WHERE p.gym_id = ? AND p.created_at >= ?
      ORDER BY p.created_at DESC
    `,
      [gymId, startOfDay],
    ),
    db.raw(
      `
      SELECT
        count(*) FILTER (WHERE decision IN ('allowed', 'override'))::int AS allowed,
        count(*) FILTER (WHERE decision LIKE 'denied%')::int             AS denied,
        count(DISTINCT member_id) FILTER
          (WHERE decision IN ('allowed', 'override') AND member_id IS NOT NULL)::int AS unique_members
      FROM check_ins
      WHERE gym_id = ? AND checked_in_at >= ?
    `,
      [gymId, startOfDay],
    ),
    occupancyService.getOccupancy(gymId),
    db('guests')
      .where({ gym_id: gymId })
      .where('created_at', '>=', startOfDay)
      .count<{ count: string }>('id as count')
      .first(),
  ]);

  const paymentRows = payments.rows as { amount: string }[];
  res.json({
    new_members: newMembers.rows,
    expiring: expiring.rows,
    payments_today: {
      count: paymentRows.length,
      total: paymentRows.reduce((sum, p) => sum + Number(p.amount), 0),
      rows: payments.rows,
    },
    check_ins_today: checkInRow.rows[0],
    occupancy,
    guests_today: Number(guestRow?.count ?? 0),
  });
}
