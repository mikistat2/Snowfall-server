"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.stats = stats;
exports.today = today;
const knex_1 = require("../db/knex");
const checkInModel = __importStar(require("../models/checkInModel"));
const paymentModel = __importStar(require("../models/paymentModel"));
const occupancyService = __importStar(require("../services/occupancyService"));
async function stats(req, res) {
    const gymId = req.auth.gymId;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const in7days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const [checkInsToday, occupancy, revenueThisMonth, expiringSoonRow, memberCounts, peakHours] = await Promise.all([
        checkInModel.countToday(gymId, now),
        occupancyService.getOccupancy(gymId),
        paymentModel.revenueSince(gymId, startOfMonth),
        (0, knex_1.db)('subscriptions as s')
            .join('members as m', 'm.id', 's.member_id')
            .where('s.gym_id', gymId)
            .whereNull('m.archived_at')
            .whereNot('s.status', 'frozen')
            .whereBetween('s.expires_at', [now, in7days])
            .countDistinct('s.member_id as count')
            .first(),
        (0, knex_1.db)('members')
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
        members_by_status: Object.fromEntries(memberCounts.map((r) => [r.status, Number(r.count)])),
        peak_hours: peakHours,
    });
}
/**
 * "Today" digest for the sidebar page: everything that happened today (new
 * members, payments, check-ins, guest passes) plus who is about to expire in
 * the next 7 days and who just expired in the last 7 — actionable follow-ups.
 */
async function today(req, res) {
    const gymId = req.auth.gymId;
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const [newMembers, expiring, payments, checkInRow, occupancy, guestRow] = await Promise.all([
        knex_1.db.raw(`
      SELECT m.id, m.full_name, m.phone, m.created_at, p.name AS plan_name
      FROM members m
      LEFT JOIN LATERAL (
        SELECT pl.name FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id
        WHERE s.member_id = m.id ORDER BY s.created_at DESC LIMIT 1
      ) p ON TRUE
      WHERE m.gym_id = ? AND m.created_at >= ? AND m.archived_at IS NULL
      ORDER BY m.created_at DESC
    `, [gymId, startOfDay]),
        // latest subscription per member, within ±7 days of today (negative
        // days_left = just expired; the client splits the two groups)
        knex_1.db.raw(`
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
    `, [gymId]),
        knex_1.db.raw(`
      SELECT p.id, p.amount, p.method, p.created_at, m.full_name AS member_name
      FROM payments p JOIN members m ON m.id = p.member_id
      WHERE p.gym_id = ? AND p.created_at >= ?
      ORDER BY p.created_at DESC
    `, [gymId, startOfDay]),
        knex_1.db.raw(`
      SELECT
        count(*) FILTER (WHERE decision IN ('allowed', 'override'))::int AS allowed,
        count(*) FILTER (WHERE decision LIKE 'denied%')::int             AS denied,
        count(DISTINCT member_id) FILTER
          (WHERE decision IN ('allowed', 'override') AND member_id IS NOT NULL)::int AS unique_members
      FROM check_ins
      WHERE gym_id = ? AND checked_in_at >= ?
    `, [gymId, startOfDay]),
        occupancyService.getOccupancy(gymId),
        (0, knex_1.db)('guests')
            .where({ gym_id: gymId })
            .where('created_at', '>=', startOfDay)
            .count('id as count')
            .first(),
    ]);
    const paymentRows = payments.rows;
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
//# sourceMappingURL=dashboardController.js.map