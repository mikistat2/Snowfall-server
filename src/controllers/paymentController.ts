import type { Request, Response } from 'express';
import * as paymentModel from '../models/paymentModel';
import type { PaymentMethod } from '../types';

export async function list(req: Request, res: Response): Promise<void> {
  res.json(
    await paymentModel.list(req.auth.gymId, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      method: req.query.method as PaymentMethod | undefined,
      member_id: req.query.member_id ? Number(req.query.member_id) : undefined,
    }),
  );
}
