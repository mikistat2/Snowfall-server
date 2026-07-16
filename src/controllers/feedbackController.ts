import type { Request, Response } from 'express';
import * as feedbackService from '../services/feedbackService';

export async function submit(req: Request, res: Response): Promise<void> {
  await feedbackService.sendFeedback({
    gymId: req.auth.gymId,
    userId: req.auth.sub,
    category: req.body.category,
    subject: req.body.subject ?? '',
    message: req.body.message,
  });
  res.status(202).json({ sent: true });
}
