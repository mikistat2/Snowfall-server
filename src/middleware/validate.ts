import type { Request, Response, NextFunction } from 'express';
import type { ZodTypeAny } from 'zod';
import { badRequest } from '../utils/errors';

/** Validates req.body (or query) against a zod schema and replaces it with the parsed value. */
export const validate =
  (schema: ZodTypeAny, target: 'body' | 'query' = 'body') =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[target]);
    if (!result.success) {
      const first = result.error.issues[0];
      throw badRequest(
        first ? `${first.path.join('.') || target}: ${first.message}` : 'Invalid input',
        'validation',
      );
    }
    if (target === 'body') req.body = result.data;
    else Object.assign(req.query, result.data);
    next();
  };
