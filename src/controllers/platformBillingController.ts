import type { Request, Response } from 'express';
import { env } from '../config/env';
import * as billingModel from '../models/billingModel';
import * as billingService from '../services/billingService';
import * as verification from '../services/verificationService';
import * as gymModel from '../models/gymModel';
import * as platformAlert from '../services/platformAlertService';
import { badRequest, conflict, notFound } from '../utils/errors';
import type { BillingCycle, BillingProvider, BillingStatus } from '../types';

/**
 * Platform-owner control over subscription billing: the master switch, the
 * prices, our own payment accounts, and every verification attempt any gym has
 * ever made.
 *
 * The verification API key is NEVER sent to the browser — the panel is told
 * only whether one is present.
 */

export async function getSettings(_req: Request, res: Response): Promise<void> {
  const settings = await billingModel.getSettings();
  res.json({
    ...settings,
    verificationConfigured: verification.isConfigured(),
    verificationEnvVar: 'VERIFY_API_KEY',
    /** Mirrors the server-side matcher so the admin sees what the bank is asked to match. */
    cbeAccountSuffix: (settings.cbe_account_number ?? '').replace(/\D/g, '').slice(-8) || null,
  });
}

export async function updateSettings(req: Request, res: Response): Promise<void> {
  const patch = req.body as Record<string, unknown>;
  const updated = await billingModel.updateSettings(patch);
  res.json({
    ...updated,
    verificationConfigured: verification.isConfigured(),
    verificationEnvVar: 'VERIFY_API_KEY',
    cbeAccountSuffix: (updated.cbe_account_number ?? '').replace(/\D/g, '').slice(-8) || null,
  });
}

// ---------------------------------------------------------------- plans ----

export async function listPlans(_req: Request, res: Response): Promise<void> {
  res.json(await billingModel.listPlans(true));
}

export async function createPlan(req: Request, res: Response): Promise<void> {
  res.status(201).json(await billingModel.createPlan(req.body));
}

export async function updatePlan(req: Request, res: Response): Promise<void> {
  const plan = await billingModel.updatePlan(Number(req.params.id), req.body);
  if (!plan) throw notFound('Plan not found');
  res.json(plan);
}

/**
 * A plan with payments against it is never deleted — historic rows must keep
 * pointing at what was actually sold. Deactivate it instead.
 */
export async function removePlan(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  const usage = await billingModel.planUsage(id);
  if (usage > 0) {
    throw conflict(
      `This plan has ${usage} payment${usage === 1 ? '' : 's'} recorded against it, so it cannot be deleted — ` +
        `the history must keep pointing at what was sold. Switch it off instead and it disappears from the ` +
        `billing page.`,
    );
  }
  await billingModel.deletePlan(id);
  res.json({ ok: true });
}

// ------------------------------------------------------------- attempts ----

export async function listAttempts(req: Request, res: Response): Promise<void> {
  const page = Math.max(1, Number(req.query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 25)));
  const status = req.query.status as BillingStatus | undefined;

  const { rows, total } = await billingModel.listAll({
    search: req.query.search as string | undefined,
    status: status && ['PENDING', 'VERIFIED', 'REJECTED'].includes(status) ? status : undefined,
    page,
    pageSize,
  });

  res.json({
    data: rows,
    meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  });
}

// ------------------------------------------------- manual / cash payment ----

export async function recordPayment(req: Request, res: Response): Promise<void> {
  const gymId = Number(req.params.id);
  const gym = await gymModel.findById(gymId);
  if (!gym) throw notFound('Gym not found');

  const { planId, cycle, amount, provider, note } = req.body as {
    planId: number | null;
    cycle: BillingCycle;
    amount: number;
    provider: BillingProvider;
    note: string;
  };
  if (!note?.trim()) throw badRequest('A note is required — record how and when this payment was received.');

  const { payment, expiresAt } = await billingService.recordManualPayment({
    gymId,
    planId: planId ?? null,
    cycle,
    amount,
    provider,
    note: note.trim(),
    recordedBy: req.platform?.name ?? 'platform admin',
  });

  void platformAlert
    .notifyGymOwners(gymId, gym.name, 'renew', new Date(expiresAt).toDateString())
    .catch(() => undefined);

  res.json({ payment, expiresAt });
}

/**
 * Grant or revoke a permanent exemption from the paywall. Used for gyms that
 * joined while payments were switched off, and for anyone we choose to
 * grandfather by hand.
 */
export async function setComped(req: Request, res: Response): Promise<void> {
  const gymId = Number(req.params.id);
  const { comped } = req.body as { comped: boolean };
  const gym = await gymModel.findById(gymId);
  if (!gym) throw notFound('Gym not found');
  await gymModel.setComped(gymId, comped);
  res.json({ ok: true, comped });
}

/** Whether the verification key is present — used for the admin warning banner. */
export function verificationStatus(_req: Request, res: Response): void {
  res.json({
    configured: verification.isConfigured(),
    envVar: 'VERIFY_API_KEY',
    baseUrl: env.verification.baseUrl,
  });
}
