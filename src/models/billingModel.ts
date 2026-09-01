import type { Knex } from 'knex';
import { db } from '../db/knex';
import type {
  BillingPaymentRow,
  BillingPlanRow,
  BillingSettings,
  BillingStatus,
} from '../types';

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
] as const;

// ------------------------------------------------------------- settings ----

const SETTINGS_DEFAULTS: BillingSettings = {
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
export async function getSettings(trx: Knex = db): Promise<BillingSettings> {
  const row = await trx('billing_settings').first(Object.keys(SETTINGS_DEFAULTS));
  return { ...SETTINGS_DEFAULTS, ...(row ?? {}) };
}

export async function updateSettings(patch: Partial<BillingSettings>): Promise<BillingSettings> {
  await db('billing_settings').update({ ...patch, updated_at: db.fn.now() });
  return getSettings();
}

// ---------------------------------------------------------------- plans ----

export async function listPlans(includeInactive = false): Promise<BillingPlanRow[]> {
  const q = db('billing_plans').select('*').orderBy(['sort_order', 'id']);
  if (!includeInactive) q.where({ is_active: true });
  return q;
}

export async function findPlan(id: number, trx: Knex = db): Promise<BillingPlanRow | undefined> {
  return trx('billing_plans').where({ id }).first();
}

export async function createPlan(data: {
  name: string;
  description?: string | null;
  monthly_price: number;
  yearly_price: number;
  currency?: string;
  sort_order?: number;
  is_active?: boolean;
  camera?: boolean;
  telegram?: boolean;
  member_limit?: number | null;
  setup_fee?: number;
}): Promise<BillingPlanRow> {
  const [row] = await db('billing_plans').insert(data).returning('*');
  return row;
}

export async function updatePlan(
  id: number,
  patch: Partial<{
    name: string;
    description: string | null;
    monthly_price: number;
    yearly_price: number;
    currency: string;
    sort_order: number;
    is_active: boolean;
    camera: boolean;
    telegram: boolean;
    member_limit: number | null;
    setup_fee: number;
  }>,
): Promise<BillingPlanRow | undefined> {
  const [row] = await db('billing_plans')
    .where({ id })
    .update({ ...patch, updated_at: db.fn.now() })
    .returning('*');
  return row;
}

/** How many payment attempts point at this plan — a plan with history is deactivated, never deleted. */
export async function planUsage(id: number): Promise<number> {
  const row = await db('billing_payments').where({ billing_plan_id: id }).count<{ count: string }[]>('* as count');
  return Number(row[0]?.count ?? 0);
}

export async function deletePlan(id: number): Promise<void> {
  await db('billing_plans').where({ id }).delete();
}

// ------------------------------------------------------------- payments ----

export type NewPayment = Omit<BillingPaymentRow, 'id' | 'created_at' | 'warnings' | 'checks'> & {
  warnings?: string[] | null;
  checks?: unknown;
  raw_response?: unknown;
};

export async function createPayment(data: Partial<NewPayment>, trx: Knex = db): Promise<BillingPaymentRow> {
  const [row] = await trx('billing_payments')
    .insert({
      ...data,
      warnings: data.warnings ? JSON.stringify(data.warnings) : null,
      checks: data.checks ? JSON.stringify(data.checks) : null,
      raw_response: data.raw_response ? JSON.stringify(data.raw_response) : null,
    })
    .returning(PUBLIC_COLUMNS as unknown as string[]);
  return row;
}

/**
 * Has this reference already been *successfully* used? Checked before calling
 * the provider API: each verification costs a credit, and we already know the
 * answer. Returns the owning gym so the caller can say "your account" versus
 * "another account".
 */
export async function findByVerifiedReference(
  reference: string,
  trx: Knex = db,
): Promise<{ id: number; gym_id: number } | undefined> {
  return trx('billing_payments')
    .whereRaw('lower(verified_reference) = lower(?)', [reference])
    .first('id', 'gym_id');
}

export async function listForGym(gymId: number, limit = 20): Promise<BillingPaymentRow[]> {
  return db('billing_payments')
    .where({ gym_id: gymId })
    .select(PUBLIC_COLUMNS as unknown as string[])
    .orderBy('created_at', 'desc')
    .limit(limit);
}

export interface AttemptFilter {
  search?: string;
  status?: BillingStatus;
  page?: number;
  pageSize?: number;
}

export interface AttemptPage {
  rows: (BillingPaymentRow & { gym_name: string; owner_email: string | null; plan_name: string | null })[];
  total: number;
}

/** Every attempt across every gym, for the platform panel. */
export async function listAll(filter: AttemptFilter = {}): Promise<AttemptPage> {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 25));

  const base = db('billing_payments as bp')
    .join('gyms as g', 'g.id', 'bp.gym_id')
    .leftJoin('billing_plans as pl', 'pl.id', 'bp.billing_plan_id')
    .leftJoin(
      db('users').select('gym_id').min('email as email').where({ role: 'owner' }).groupBy('gym_id').as('o'),
      'o.gym_id',
      'g.id',
    );

  if (filter.status) base.where('bp.status', filter.status);
  if (filter.search?.trim()) {
    const like = `%${filter.search.trim()}%`;
    // ILIKE is Postgres-only, which is what this project runs on.
    base.where((q) =>
      q
        .whereRaw('bp.reference ILIKE ?', [like])
        .orWhereRaw('bp.reason_code ILIKE ?', [like])
        .orWhereRaw('bp.payer_name ILIKE ?', [like])
        .orWhereRaw('g.name ILIKE ?', [like])
        .orWhereRaw('o.email ILIKE ?', [like]),
    );
  }

  const countRow = await base.clone().count<{ count: string }[]>('bp.id as count');
  const rows = await base
    .clone()
    .select(
      ...PUBLIC_COLUMNS.map((c) => `bp.${c}`),
      'g.name as gym_name',
      'o.email as owner_email',
      'pl.name as plan_name',
    )
    .orderBy('bp.created_at', 'desc')
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return { rows, total: Number(countRow[0]?.count ?? 0) };
}

/** Debug/support only — carries the payer's full account number. */
export async function findRawResponse(id: number): Promise<unknown> {
  const row = await db('billing_payments').where({ id }).first('raw_response');
  return row?.raw_response ?? null;
}
