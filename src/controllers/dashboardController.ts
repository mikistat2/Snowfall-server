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
        .whereNot('s.status', 'frozen')
        .whereBetween('s.expires_at', [now, in7days])
        .countDistinct<{ count: string }>('s.member_id as count')
        .first(),
      db('members')
        .where({ gym_id: gymId })
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
