"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSettings = getSettings;
exports.updateSettings = updateSettings;
exports.listPlans = listPlans;
exports.findPlan = findPlan;
exports.createPlan = createPlan;
exports.updatePlan = updatePlan;
exports.planUsage = planUsage;
exports.deletePlan = deletePlan;
exports.createPayment = createPayment;
exports.findByVerifiedReference = findByVerifiedReference;
exports.listForGym = listForGym;
exports.listAll = listAll;
exports.findRawResponse = findRawResponse;
const knex_1 = require("../db/knex");
/**
 * Data access for platform subscription billing (gyms paying us).
 *
 * `raw_response` holds the provider's untouched payload, which includes the
 * payer's full account number. Every read here selects columns explicitly and
 * leaves it out — it must never reach an API response. Only
 * `findRawResponse()` returns it, and nothing calls that from a route.
 */
const PUBLIC_COLUMNS = [
    'id',
    'gym_id',
    'billing_plan_id',
    'provider',
    'source',
    'status',
    'reference',
    'reason_code',
    'verified_reference',
    'selected_cycle',
    'granted_cycle',
    'amount',
    'currency',
    'expected_amount',
    'payer_name',
    'payer_account',
    'receiver_name',
    'receiver_account',
    'transaction_at',
    'period_start',
    'period_end',
    'failure_reason',
    'warnings',
    'checks',
    'recorded_by',
    'note',
    'verified_at',
    'created_at',
];
// ------------------------------------------------------------- settings ----
const SETTINGS_DEFAULTS = {
    payments_required: false,
    cbe_enabled: true,
    cbe_account_number: null,
    cbe_account_name: null,
    telebirr_enabled: true,
    telebirr_phone: null,
    telebirr_account_name: null,
    currency: 'ETB',
    receipt_max_age_days: 7,
    grace_days: 0,
    instructions: null,
};
/** The singleton row. Falls back to defaults so callers never see undefined. */
async function getSettings(trx = knex_1.db) {
    const row = await trx('billing_settings').first(Object.keys(SETTINGS_DEFAULTS));
    return { ...SETTINGS_DEFAULTS, ...(row ?? {}) };
}
async function updateSettings(patch) {
    await (0, knex_1.db)('billing_settings').update({ ...patch, updated_at: knex_1.db.fn.now() });
    return getSettings();
}
// ---------------------------------------------------------------- plans ----
async function listPlans(includeInactive = false) {
    const q = (0, knex_1.db)('billing_plans').select('*').orderBy(['sort_order', 'id']);
    if (!includeInactive)
        q.where({ is_active: true });
    return q;
}
async function findPlan(id, trx = knex_1.db) {
    return trx('billing_plans').where({ id }).first();
}
async function createPlan(data) {
    const [row] = await (0, knex_1.db)('billing_plans').insert(data).returning('*');
    return row;
}
async function updatePlan(id, patch) {
    const [row] = await (0, knex_1.db)('billing_plans')
        .where({ id })
        .update({ ...patch, updated_at: knex_1.db.fn.now() })
        .returning('*');
    return row;
}
/** How many payment attempts point at this plan — a plan with history is deactivated, never deleted. */
async function planUsage(id) {
    const row = await (0, knex_1.db)('billing_payments').where({ billing_plan_id: id }).count('* as count');
    return Number(row[0]?.count ?? 0);
}
async function deletePlan(id) {
    await (0, knex_1.db)('billing_plans').where({ id }).delete();
}
async function createPayment(data, trx = knex_1.db) {
    const [row] = await trx('billing_payments')
        .insert({
        ...data,
        warnings: data.warnings ? JSON.stringify(data.warnings) : null,
        checks: data.checks ? JSON.stringify(data.checks) : null,
        raw_response: data.raw_response ? JSON.stringify(data.raw_response) : null,
    })
        .returning(PUBLIC_COLUMNS);
    return row;
}
/**
 * Has this reference already been *successfully* used? Checked before calling
 * the provider API: each verification costs a credit, and we already know the
 * answer. Returns the owning gym so the caller can say "your account" versus
 * "another account".
 */
async function findByVerifiedReference(reference, trx = knex_1.db) {
    return trx('billing_payments')
        .whereRaw('lower(verified_reference) = lower(?)', [reference])
        .first('id', 'gym_id');
}
async function listForGym(gymId, limit = 20) {
    return (0, knex_1.db)('billing_payments')
        .where({ gym_id: gymId })
        .select(PUBLIC_COLUMNS)
        .orderBy('created_at', 'desc')
        .limit(limit);
}
/** Every attempt across every gym, for the platform panel. */
async function listAll(filter = {}) {
    const page = Math.max(1, filter.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 25));
    const base = (0, knex_1.db)('billing_payments as bp')
        .join('gyms as g', 'g.id', 'bp.gym_id')
        .leftJoin('billing_plans as pl', 'pl.id', 'bp.billing_plan_id')
        .leftJoin((0, knex_1.db)('users').select('gym_id').min('email as email').where({ role: 'owner' }).groupBy('gym_id').as('o'), 'o.gym_id', 'g.id');
    if (filter.status)
        base.where('bp.status', filter.status);
    if (filter.search?.trim()) {
        const like = `%${filter.search.trim()}%`;
        // ILIKE is Postgres-only, which is what this project runs on.
        base.where((q) => q
            .whereRaw('bp.reference ILIKE ?', [like])
            .orWhereRaw('bp.reason_code ILIKE ?', [like])
            .orWhereRaw('bp.payer_name ILIKE ?', [like])
            .orWhereRaw('g.name ILIKE ?', [like])
            .orWhereRaw('o.email ILIKE ?', [like]));
    }
    const countRow = await base.clone().count('bp.id as count');
    const rows = await base
        .clone()
        .select(...PUBLIC_COLUMNS.map((c) => `bp.${c}`), 'g.name as gym_name', 'o.email as owner_email', 'pl.name as plan_name')
        .orderBy('bp.created_at', 'desc')
        .limit(pageSize)
        .offset((page - 1) * pageSize);
    return { rows, total: Number(countRow[0]?.count ?? 0) };
}
/** Debug/support only — carries the payer's full account number. */
async function findRawResponse(id) {
    const row = await (0, knex_1.db)('billing_payments').where({ id }).first('raw_response');
    return row?.raw_response ?? null;
}
//# sourceMappingURL=billingModel.js.map