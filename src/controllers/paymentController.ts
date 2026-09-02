import type { Request, Response } from 'express';
import * as paymentModel from '../models/paymentModel';
import { parseLimit, parseOffset } from '../utils/pagination';
import type { PaymentMethod } from '../types';

/** The filter both the list and the summary read, parsed once. */
function paymentFilter(req: Request) {
  return {
    from: req.query.from as string | undefined,
    to: req.query.to as string | undefined,
    method: req.query.method as PaymentMethod | undefined,
    member_id: req.query.member_id ? Number(req.query.member_id) : undefined,
  };
}

export async function list(req: Request, res: Response): Promise<void> {
  res.json(
    await paymentModel.list(
      req.auth.gymId,
      { ...paymentFilter(req), offset: parseOffset(req.query.offset) },
      parseLimit(req.query.limit) ?? 200,
    ),
  );
}

/**
 * Count and total for the current filter, across every matching payment.
 *
 * Separate from the list because it answers a different question and changes
 * far less often: the page fetches more rows as the reader scrolls, but the
 * headline figure is settled by the filter alone, so it is fetched once per
 * filter rather than once per page.
 */
export async function summary(req: Request, res: Response): Promise<void> {
  res.json(await paymentModel.summary(req.auth.gymId, paymentFilter(req)));
}
