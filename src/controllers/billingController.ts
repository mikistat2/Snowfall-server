import type { Request, Response } from 'express';
import * as billingService from '../services/billingService';
import { badRequest } from '../utils/errors';
import type { BillingCycle, BillingProvider } from '../types';

/**
 * Gym-facing billing: what to pay, and proof that it was paid.
 *
 * A REJECTED receipt is a 200, not an error. The per-check breakdown is the
 * whole point of the response and the page renders it either way; an HTTP
 * error status would send it down the client's failure path where only the
 * message survives. Real error statuses are reserved for things that are not
 * a receipt verdict: 409 replay, 422 unreadable QR / provider off, 503 not
 * configured.
 */

export async function checkout(req: Request, res: Response): Promise<void> {
  res.json(await billingService.checkout(req.auth.gymId));
}

export async function history(req: Request, res: Response): Promise<void> {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 10)));
  res.json(await billingService.historyFor(req.auth.gymId, limit));
}

export async function verifyReference(req: Request, res: Response): Promise<void> {
  const { provider, reference, planId, cycle } = req.body as {
    provider: Exclude<BillingProvider, 'CASH'>;
    reference: string;
    planId: number;
    cycle: BillingCycle;
  };
  res.json(await billingService.submitReference(req.auth.gymId, provider, reference.trim(), planId, cycle));
}

export async function verifyScreenshot(req: Request, res: Response): Promise<void> {
  const file = req.file;
  // Multer drops the body silently when the multipart envelope overruns its
  // limit, which otherwise surfaces as a baffling "no file was uploaded".
  if (!file) throw badRequest('No screenshot was uploaded. Choose a PNG, JPG or WebP image up to 6 MB.');

  const provider = req.body.provider as Exclude<BillingProvider, 'CASH'>;
  const planId = Number(req.body.planId);
  const cycle = req.body.cycle as BillingCycle;
  if (!['CBE', 'TELEBIRR'].includes(provider)) throw badRequest('Choose a payment method.');
  if (!Number.isInteger(planId) || planId <= 0) throw badRequest('Choose a subscription plan.');
  if (!['MONTHLY', 'YEARLY'].includes(cycle)) throw badRequest('Choose monthly or yearly billing.');

  res.json(await billingService.submitScreenshot(req.auth.gymId, provider, file.buffer, planId, cycle));
}
