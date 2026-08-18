import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors';
import { env } from '../config/env';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message, code: err.code });
    return;
  }
  // Multer rejects an oversized or wrong-typed upload before the route runs;
  // its raw message ("File too large") is no use to whoever is uploading.
  if (isMulterError(err)) {
    res.status(400).json({
      error:
        err.code === 'LIMIT_FILE_SIZE'
          ? 'That screenshot is larger than 6 MB. Crop it to just the receipt, or take a smaller screenshot.'
          : 'That upload was rejected. Send a single PNG, JPG or WebP image up to 6 MB.',
    });
    return;
  }
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({
    error: env.nodeEnv === 'development' && err instanceof Error ? err.message : 'Internal server error',
  });
}

function isMulterError(err: unknown): err is { name: string; code: string } {
  return (err as { name?: string })?.name === 'MulterError';
}
