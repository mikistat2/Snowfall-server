import type { Request, Response } from 'express';
import { db } from '../db/knex';
import * as checkInModel from '../models/checkInModel';
import * as paymentModel from '../models/paymentModel';
import * as occupancyService from '../services/occupancyService';
import * as memberPhotoService from '../services/memberPhotoService';

/** The photo columns the expiring query selects, for photoUrls(). */
type PhotoColumns = { photo_key: string | null; photo_version: number };

export async function stats(req: Request, res: Response): Promise<void> {
  const gymId = req.auth.gymId;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const in7days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const [
    checkInsToday,
    occupancy,
    revenueThisMonth,
    expiringSoonRow,
    memberCounts,
    sexCounts,
    peakHours,
  ] = await Promise.all([
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
    // Roster split by sex. A gym running without a camera has no check-ins
    // and no live occupancy, so this is what its dashboard shows instead.
    db('members')
      .where({ gym_id: gymId })
      .whereNull('archived_at')
      .select('sex')
      .count('id as count')
      .groupBy('sex'),
    checkInModel.peakHours(gymId, 14),
  ]);

  const bySex = { male: 0, female: 0, unspecified: 0 };
  for (const row of sexCounts as { sex: string | null; count: string }[]) {
    const bucket = row.sex === 'male' || row.sex === 'female' ? row.sex : 'unspecified';
    bySex[bucket] += Number(row.count);
  }

  res.json({
    check_ins_today: checkInsToday,
    occupancy,
    revenue_this_month: revenueThisMonth,
    expiring_in_7_days: Number(expiringSoonRow?.count ?? 0),
    members_by_status: Object.fromEntries(
      (memberCounts as { status: string; count: string }[]).map((r) => [r.status, Number(r.count)]),
    ),
    members_by_sex: bySex,
    members_total: bySex.male + bySex.female + bySex.unspecified,
    peak_hours: peakHours,
  });
}

/**
 * "Today" digest for the sidebar page: everything that happened today (new
 * members, payments, check-ins, guest passes) plus who is about to expire in
 * the next 7 days and who just expired in the last 7 — actionable follow-ups.
 *
 * Not paginated, and deliberately so: every list here is bounded by a date
 * window rather than by the size of the gym. "Today" resets each morning and
 * the expiry window is fourteen days wide, so none of them grows without limit
 * the way the members roster does. The one exception is the payment list, which
 * grows with how busy the day was — that one is capped below.
 */
const TODAY_PAYMENT_ROWS = 50;

export async function today(req: Request, res: Response): Promise<void> {
  const gymId = req.auth.gymId;
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const [newMembers, expiring, payments, checkInRow, occupancy, guestRow] = await Promise.all([
    db.raw(
      `
      SELECT m.id, m.full_name, m.phone, m.created_at, p.name AS plan_name,
             m.photo_key, m.photo_version
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
             m.photo_key, m.photo_version,
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
    /**
     * Today's payments: the count and the sum over all of them, but only the
     * newest `TODAY_PAYMENT_ROWS` rows to display.
     *
     * The two are separated on purpose. The tile shows the day's takings and
     * has to be exact, so it is aggregated in SQL rather than by adding up
     * whatever rows were sent. The list underneath is a glance at the recent
     * few — nobody scrolls a day's receipts here, that is what the Payments
     * page is for — so capping it bounds a response that would otherwise grow
     * with how busy the gym was.
     */
    db.raw(
      `
      SELECT
        (SELECT count(*)::int FROM payments
          WHERE gym_id = :gymId AND created_at >= :start)                    AS count,
        (SELECT coalesce(sum(amount), 0) FROM payments
          WHERE gym_id = :gymId AND created_at >= :start)                    AS total,
        coalesce((
          SELECT json_agg(r) FROM (
            SELECT p.id, p.amount, p.method, p.created_at, m.full_name AS member_name
            FROM payments p JOIN members m ON m.id = p.member_id
            WHERE p.gym_id = :gymId AND p.created_at >= :start
            ORDER BY p.created_at DESC
            LIMIT :limit
          ) r
        ), '[]'::json)                                                       AS rows
    `,
      { gymId, start: startOfDay, limit: TODAY_PAYMENT_ROWS },
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

  const today = payments.rows[0] as { count: number; total: string; rows: unknown[] };
  res.json({
    // Today's sign-ups, with a face each — bounded by the day, so a handful.
    new_members: (newMembers.rows as PhotoColumns[]).map((row) => ({
      ...row,
      ...memberPhotoService.photoUrls(row),
    })),
    /**
     * Photo URLs on the follow-up list.
     *
     * These are the members someone is about to phone or chase at the door, so
     * a face beside the name is worth more here than anywhere else — and it
     * costs nothing extra: this list is capped by a fourteen-day window, and it
     * is the same expiring/grace/expired set the roster already loads
     * thumbnails for, so the images are usually in the browser cache already.
     */
    expiring: (expiring.rows as PhotoColumns[]).map((row) => ({
      ...row,
      ...memberPhotoService.photoUrls(row),
    })),
    payments_today: {
      // count and total are the whole day, from SQL; rows are the capped
      // display list, so the tile stays right even when the list is trimmed.
      count: today.count,
      total: Number(today.total),
      rows: today.rows,
    },
    check_ins_today: checkInRow.rows[0],
    occupancy,
    guests_today: Number(guestRow?.count ?? 0),
  });
}
