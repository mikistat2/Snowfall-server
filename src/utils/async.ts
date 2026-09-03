import type { Request, Response, NextFunction, RequestHandler } from 'express';

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/** Wraps an async controller so rejections reach the error middleware. */
export const asyncHandler =
  (fn: AsyncHandler): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

/**
 * Resolves to `undefined` if `promise` has not settled within `ms`.
 *
 * For best-effort side work hanging off a request that has already succeeded —
 * an owner alert over Telegram or SMTP, say. The gym's payment went through; a
 * mail server that takes thirty seconds to answer must not hold the response
 * open that long, and its silence is not an error worth reporting.
 *
 * The timer is unref'd so a pending one never keeps the process alive.
 */
export async function timeboxed<T>(promise: Promise<T>, ms = 4000): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms).unref?.()),
  ]);
}
