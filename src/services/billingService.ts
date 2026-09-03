import crypto from 'node:crypto';
import { db } from '../db/knex';
import { env } from '../config/env';
import * as billingModel from '../models/billingModel';
import * as gymModel from '../models/gymModel';
import * as auditLogModel from '../models/auditLogModel';
import * as featureNoticeModel from '../models/featureNoticeModel';
import * as platformAlert from './platformAlertService';
import * as botManager from '../telegram/botManager';
import * as verification from './verificationService';
import * as receiptQr from './receiptQrService';
import { computePeriod, grantPatch, grantsFor, priceFor, runChecks } from './billingChecks';
import { AppError, badRequest, conflict, notFound } from '../utils/errors';
import { timeboxed } from '../utils/async';
import type {
  BillingCycle,
  BillingPaymentRow,
  BillingPlanRow,
  BillingProvider,
  BillingSettings,
  FeatureKey,
  GymRow,
  PaymentCheck,
} from '../types';

/**
 * Platform subscription billing: everything a gym does to pay us, and the
 * single implementation of "does this gym have access".
 */

// ------------------------------------------------------------- reason code --

/**
 * Ambiguous glyphs are removed — no 0/O, no 1/I/L — because gym owners read
 * this off a screen and type it into a banking app on a phone.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function mintCode(): string {
  const bytes = crypto.randomBytes(6);
  let code = '';
  for (const byte of bytes) code += CODE_ALPHABET.charAt(byte % CODE_ALPHABET.length);
  return code;
}

/**
 * The gym's payment code, minted once and stable for the life of the account.
 * The same code is used for the first payment and every renewal, so an owner
 * who pays a day late or renews next year still matches. Never rotate it.
 */
export async function reasonCodeFor(gymId: number): Promise<string> {
  const gym = await gymModel.findById(gymId);
  if (!gym) throw notFound('Gym not found');
  if (gym.payment_reason_code) return gym.payment_reason_code;

  // Collisions at 31^6 are vanishingly unlikely, but the column is UNIQUE, so
  // retry rather than ever hand back a duplicate.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = mintCode();
    try {
      const [row] = await db('gyms')
        .where({ id: gymId })
        .whereNull('payment_reason_code')
        .update({ payment_reason_code: code })
        .returning('payment_reason_code');
      if (row?.payment_reason_code) return row.payment_reason_code;
      // Another request won the race — read theirs.
      const fresh = await gymModel.findById(gymId);
      if (fresh?.payment_reason_code) return fresh.payment_reason_code;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new AppError(500, 'Could not allocate a payment code. Please try again.');
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === '23505' || code === '23000';
}

// ------------------------------------------------------------- access rule --

/**
 * The single rule behind both the API middleware and the flag the client
 * guards on, so the two can never disagree.
 *
 * The platform panel authenticates on its own JWT and never passes through
 * this check, so there is no bootstrapping problem: the payment accounts can
 * always be configured even when every gym is locked out.
 */
export function hasAccess(gym: GymRow, settings: BillingSettings, now: Date = new Date()): boolean {
  if (!settings.payments_required) return true;
  if (gym.comped) return true;
  if (!gym.subscription_ends_at) return false;
  const deadline = new Date(gym.subscription_ends_at);
  deadline.setDate(deadline.getDate() + settings.grace_days);
  return deadline.getTime() > now.getTime();
}

// --------------------------------------------------------- plan entitlements --

/**
 * Tell the gym what its payment just switched on.
 *
 * Runs AFTER the transaction commits: a notice describing a payment that
 * rolled back would be a lie, and a Telegram bot cannot be started inside a
 * transaction at all.
 *
 * Best effort throughout. The money is in and the entitlement is set — a mail
 * server that is down must not turn a successful payment into an error the
 * gym sees, so everything here is swallowed and logged.
 */
async function announceGrants(gym: GymRow, planName: string, granted: FeatureKey[]): Promise<void> {
  if (granted.length === 0) return;
  const note = `Included in the ${planName} package you just paid for.`;

  try {
    // The in-app notice first: it is a row, not a delivery attempt, so it
    // reaches the owner even with no bot linked and no mail server configured.
    for (const feature of granted) {
      await featureNoticeModel.create({
        gym_id: gym.id,
        feature,
        allowed: true,
        note,
        changed_by: 'Subscription payment',
      });
    }

    // Started before the alert goes out, because news about Telegram wants a
    // running bot to travel on — same ordering as the platform panel's grant.
    if (granted.includes('telegram') && gym.telegram_bot_token) {
      await botManager.restartBot(gym.id, gym.telegram_bot_token);
    }

    await auditLogModel.log({
      gym_id: gym.id,
      user_id: null,
      action: 'billing.features_granted',
      entity: 'gym',
      entity_id: gym.id,
      meta: { plan: planName, granted, by: 'payment' },
    });

    await timeboxed(
      Promise.all(granted.map((f) => platformAlert.notifyFeatureChange(gym.id, gym.name, f, true, note))),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[billing] gym ${gym.id}: features granted but could not be announced`, err);
  }
}

// ---------------------------------------------------------------- checkout --

export interface ProviderOption {
  provider: Exclude<BillingProvider, 'CASH'>;
  label: string;
  accountNumber: string;
  accountName: string | null;
}

export interface Checkout {
  paymentsRequired: boolean;
  active: boolean;
  comped: boolean;
  isTrial: boolean;
  expiresAt: string | null;
  reasonCode: string;
  plans: BillingPlanRow[];
  currentPlanId: number | null;
  currentCycle: BillingCycle | null;
  currency: string;
  instructions: string | null;
  providers: ProviderOption[];
  /** false → no provider is ready, or the verification key is missing. */
  configured: boolean;
  graceDays: number;
}

/**
 * Only offer a provider that is BOTH enabled AND has everything needed to
 * verify it. A bank enabled without an account number would happily accept
 * money into an account we cannot check.
 */
export function readyProviders(settings: BillingSettings): ProviderOption[] {
  const options: ProviderOption[] = [];
  if (settings.cbe_enabled && settings.cbe_account_number?.trim()) {
    options.push({
      provider: 'CBE',
      label: 'Commercial Bank of Ethiopia',
      accountNumber: settings.cbe_account_number.trim(),
      accountName: settings.cbe_account_name,
    });
  }
  if (settings.telebirr_enabled && settings.telebirr_phone?.trim()) {
    options.push({
      provider: 'TELEBIRR',
      label: 'Telebirr',
      accountNumber: settings.telebirr_phone.trim(),
      accountName: settings.telebirr_account_name,
    });
  }
  return options;
}

export async function checkout(gymId: number): Promise<Checkout> {
  const [settings, gym, plans] = await Promise.all([
    billingModel.getSettings(),
    gymModel.findById(gymId),
    billingModel.listPlans(),
  ]);
  if (!gym) throw notFound('Gym not found');

  const providers = readyProviders(settings);
  return {
    paymentsRequired: settings.payments_required,
    active: hasAccess(gym, settings),
    comped: gym.comped,
    isTrial: gym.is_trial,
    expiresAt: gym.subscription_ends_at,
    reasonCode: await reasonCodeFor(gymId),
    plans,
    currentPlanId: gym.billing_plan_id,
    currentCycle: gym.billing_cycle,
    currency: settings.currency,
    instructions: settings.instructions,
    providers,
    configured: providers.length > 0 && verification.isConfigured(),
    graceDays: settings.grace_days,
  };
}

export async function historyFor(gymId: number, limit = 10): Promise<BillingPaymentRow[]> {
  return billingModel.listForGym(gymId, limit);
}

// ------------------------------------------------------------- submission --

export interface SubmitResult {
  verified: boolean;
  payment: BillingPaymentRow;
  checks: PaymentCheck[];
  error: string | null;
  /** Whether the gym has access AFTER this attempt. */
  paid: boolean;
  expiresAt: string | null;
}

interface SubmitContext {
  gym: GymRow;
  settings: BillingSettings;
  plan: BillingPlanRow | null;
  cycle: BillingCycle;
  reasonCode: string;
}

/**
 * Shared preflight: fail fast before anything is spent or written.
 *
 * Provider readiness is deliberately NOT checked here — see
 * `assertProviderReady`, which the screenshot path calls only after the QR has
 * had its say about which provider actually issued the receipt.
 */
async function prepare(gymId: number, planId: number, cycle: BillingCycle): Promise<SubmitContext> {
  const [settings, gym] = await Promise.all([billingModel.getSettings(), gymModel.findById(gymId)]);
  if (!gym) throw notFound('Gym not found');
  if (!settings.payments_required) {
    throw badRequest('Payments are switched off — your subscription does not need paying for.', 'PAYMENTS_OFF');
  }
  if (!verification.isConfigured()) {
    throw new AppError(
      503,
      'Receipt verification is not set up yet. Please contact support before sending any money.',
      'VERIFY_NOT_CONFIGURED',
    );
  }

  const plan = await billingModel.findPlan(planId);
  if (!plan || !plan.is_active) throw badRequest('That subscription plan is no longer available.');

  return { gym, settings, plan, cycle, reasonCode: await reasonCodeFor(gymId) };
}

/** Refuse a provider we have no account configured for — we could not check it. */
function assertProviderReady(settings: BillingSettings, provider: Exclude<BillingProvider, 'CASH'>): void {
  if (readyProviders(settings).some((p) => p.provider === provider)) return;
  const label = provider === 'CBE' ? 'CBE bank' : 'Telebirr';
  throw badRequest(`We are not set up to accept ${label} payments right now. Choose another method.`);
}

/**
 * Replay guard. Runs BEFORE the provider is called: each verification costs a
 * paid credit and we already know the answer.
 *
 * This is a fast path, not the guarantee — the guarantee is the UNIQUE index
 * on `verified_reference`, which is what survives two concurrent requests.
 */
async function guardReferenceUnused(reference: string, gymId: number): Promise<void> {
  const existing = await billingModel.findByVerifiedReference(reference);
  if (!existing) return;
  throw conflict(
    existing.gym_id === gymId
      ? 'That receipt has already been used to extend your subscription.'
      : 'That receipt has already been used to activate another account.',
  );
}

export async function submitReference(
  gymId: number,
  provider: Exclude<BillingProvider, 'CASH'>,
  reference: string,
  planId: number,
  cycle: BillingCycle,
): Promise<SubmitResult> {
  const ctx = await prepare(gymId, planId, cycle);
  assertProviderReady(ctx.settings, provider);
  await guardReferenceUnused(reference, gymId);
  return verifyAndRecord(ctx, { provider, reference, accountSuffix: null, source: 'MANUAL' });
}

export async function submitScreenshot(
  gymId: number,
  provider: Exclude<BillingProvider, 'CASH'>,
  file: Buffer,
  planId: number,
  cycle: BillingCycle,
): Promise<SubmitResult> {
  const ctx = await prepare(gymId, planId, cycle);

  const qr = await receiptQr.decode(file);
  // Nothing was verified and no credit was spent, so there is no attempt worth
  // keeping — 422 with an actionable message and no row written.
  if (!qr.ok || !qr.reference) throw badRequest(qr.error ?? 'No QR code could be read in that screenshot.');

  // The QR is authoritative about which provider issued the receipt; the radio
  // button on the form is only a hint. Readiness is therefore checked against
  // the EFFECTIVE provider — checking the form's value first would reject a
  // perfectly good CBE receipt for the sole reason that the owner had left
  // "Telebirr" selected.
  const effectiveProvider = qr.provider ?? provider;
  assertProviderReady(ctx.settings, effectiveProvider);

  await guardReferenceUnused(qr.reference, gymId);
  return verifyAndRecord(ctx, {
    provider: effectiveProvider,
    reference: qr.reference,
    accountSuffix: qr.accountSuffix,
    source: 'IMAGE',
  });
}

async function verifyAndRecord(
  ctx: SubmitContext,
  input: {
    provider: Exclude<BillingProvider, 'CASH'>;
    reference: string;
    accountSuffix: string | null;
    source: 'MANUAL' | 'IMAGE';
  },
): Promise<SubmitResult> {
  const envelope = await verification.lookup({
    provider: input.provider,
    reference: input.reference,
    accountSuffix: input.accountSuffix,
  });

  const outcome = runChecks({
    receipt: envelope.receipt,
    receiptError: envelope.error,
    reasonCode: ctx.reasonCode,
    plan: ctx.plan,
    selectedCycle: ctx.cycle,
    provider: input.provider,
    settings: ctx.settings,
  });

  const receipt = envelope.receipt;
  const base = {
    gym_id: ctx.gym.id,
    billing_plan_id: ctx.plan?.id ?? null,
    provider: input.provider,
    source: input.source,
    reference: receipt?.reference ?? input.reference,
    reason_code: ctx.reasonCode,
    selected_cycle: ctx.cycle,
    amount: receipt?.amount ?? null,
    currency: receipt?.currency ?? ctx.settings.currency,
    expected_amount: ctx.plan ? priceFor(ctx.plan, ctx.cycle) : null,
    payer_name: receipt?.payerName ?? null,
    payer_account: receipt?.payerAccount ?? null,
    receiver_name: receipt?.receiverName ?? null,
    receiver_account: receipt?.receiverAccount ?? null,
    transaction_at: receipt?.date ?? null,
    failure_reason: outcome.failureReason,
    warnings: outcome.warnings.length ? outcome.warnings : null,
    checks: outcome.checks,
    raw_response: env.verification.storeRawResponse ? envelope.raw : null,
  };

  if (!outcome.passed || !outcome.grantedCycle) {
    const payment = await billingModel.createPayment({
      ...base,
      status: 'REJECTED',
      granted_cycle: null,
      verified_reference: null,
    } as never);
    const gym = await gymModel.findById(ctx.gym.id);
    return {
      verified: false,
      payment,
      checks: outcome.checks,
      error: outcome.failureReason,
      paid: gym ? hasAccess(gym, ctx.settings) : false,
      expiresAt: gym?.subscription_ends_at ?? null,
    };
  }

  return activate(ctx, base, outcome.grantedCycle, receipt?.reference ?? input.reference, outcome.checks);
}

/**
 * Persisting a success is ONE transaction: the verified reference, the period
 * and the gym's new expiry are written together. That ordering matters — a
 * receipt that loses the race against the unique index never leaves a
 * subscription extended.
 */
async function activate(
  ctx: SubmitContext,
  base: Record<string, unknown>,
  grantedCycle: BillingCycle,
  verifiedReference: string,
  checks: PaymentCheck[],
): Promise<SubmitResult> {
  const { start, end } = computePeriod(ctx.gym.subscription_ends_at, grantedCycle);
  const granted = grantsFor(ctx.gym, ctx.plan);

  try {
    const payment = await db.transaction(async (trx) => {
      const row = await billingModel.createPayment(
        {
          ...base,
          status: 'VERIFIED',
          granted_cycle: grantedCycle,
          verified_reference: verifiedReference,
          period_start: start,
          period_end: end,
          verified_at: new Date(),
        } as never,
        trx,
      );
      await trx('gyms')
        .where({ id: ctx.gym.id })
        .update({
          subscription_ends_at: end,
          billing_plan_id: ctx.plan?.id ?? null,
          billing_cycle: grantedCycle,
          is_trial: false,
          // A gym that has now paid is active; approval was implicit in the money.
          status: ctx.gym.status === 'pending' ? 'active' : ctx.gym.status,
          approved_at: ctx.gym.approved_at ?? new Date(),
          // Whatever the package includes and the gym does not have yet.
          ...grantPatch(granted),
        });
      return row;
    });

    // After the commit, and never allowed to fail the payment. See announceGrants.
    await announceGrants(ctx.gym, ctx.plan?.name ?? '', granted);

    return {
      verified: true,
      payment,
      checks,
      error: null,
      paid: true,
      expiresAt: end.toISOString(),
    };
  } catch (err) {
    // Lost the race for this reference — a 409, never a 500.
    if (isUniqueViolation(err)) {
      throw conflict('That receipt has already been used to activate an account.');
    }
    throw err;
  }
}

// ------------------------------------------------ admin / cash at the desk --

/**
 * Recorded by a platform admin for a gym that paid cash, by hand, or through
 * any channel we cannot verify. It runs the same renewal maths as a verified
 * payment so there is exactly one implementation of the expiry rule, and it
 * carries no `verified_reference` — an unverifiable payment must stay visibly
 * different from a bank-verified one.
 *
 * `startNow` starts the paid period today instead of stacking it on the time
 * that is left. That is what converting a free trial means: the unused trial
 * days were never paid for, so they are not added on top of the month bought.
 */
export async function recordManualPayment(input: {
  gymId: number;
  planId: number | null;
  cycle: BillingCycle;
  amount: number;
  provider: BillingProvider;
  note: string;
  recordedBy: string;
  /** Ignore any remaining time and run the period from today. */
  startNow?: boolean;
}): Promise<{ payment: BillingPaymentRow; expiresAt: string; startsAt: string; convertedFromTrial: boolean }> {
  const [settings, gym] = await Promise.all([billingModel.getSettings(), gymModel.findById(input.gymId)]);
  if (!gym) throw notFound('Gym not found');
  const plan = input.planId ? await billingModel.findPlan(input.planId) : null;

  const { start, end } = computePeriod(input.startNow ? null : gym.subscription_ends_at, input.cycle);
  const wasTrial = gym.is_trial;
  // A payment an admin records by hand buys the same package a self-service
  // one does, so it grants the same features.
  const granted = grantsFor(gym, plan);

  const payment = await db.transaction(async (trx) => {
    const row = await billingModel.createPayment(
      {
        gym_id: gym.id,
        billing_plan_id: plan?.id ?? null,
        provider: input.provider,
        source: 'ADMIN',
        status: 'VERIFIED',
        reason_code: gym.payment_reason_code,
        selected_cycle: input.cycle,
        granted_cycle: input.cycle,
        amount: input.amount,
        currency: settings.currency,
        expected_amount: plan ? priceFor(plan, input.cycle) : null,
        period_start: start,
        period_end: end,
        recorded_by: input.recordedBy,
        note: input.note,
        verified_at: new Date(),
        warnings: [
          'Recorded by a platform admin — not verified against a bank receipt.',
          ...(wasTrial ? ['Converted this gym from its free trial to a paid subscription.'] : []),
        ],
      } as never,
      trx,
    );
    await trx('gyms')
      .where({ id: gym.id })
      .update({
        subscription_ends_at: end,
        billing_plan_id: plan?.id ?? gym.billing_plan_id,
        billing_cycle: input.cycle,
        is_trial: false,
        status: gym.status === 'pending' ? 'active' : gym.status,
        approved_at: gym.approved_at ?? new Date(),
        ...grantPatch(granted),
      });
    return row;
  });

  await announceGrants(gym, plan?.name ?? '', granted);

  return {
    payment,
    expiresAt: end.toISOString(),
    startsAt: start.toISOString(),
    convertedFromTrial: wasTrial,
  };
}
