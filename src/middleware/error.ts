import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors';
import { env } from '../config/env';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message, code: err.code });
    return;
  }
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({
    error: env.nodeEnv === 'development' && err instanceof Error ? err.message : 'Internal server error',
  });
}
