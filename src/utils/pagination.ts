import type { Request } from 'express';
import type { PageMeta, Paged } from '../types';

/**
 * Two ways of asking for less than everything, for two different jobs.
 *
 * `parseLimit`/`parseOffset` are the older pair, used by the member and
 * payment lists: a window with no row count, which is all a "load more" needs.
 *
 * `pageParams`/`pagedBody` back a real pager — the notification and audit
 * pages, where the reader has to be told how many pages exist before they can
 * choose one. That needs a COUNT, so it is a separate path rather than a flag
 * on the first.
 */

const MAX_LIMIT = 200;

export function parseLimit(raw: unknown): number | undefined {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(Math.floor(value), MAX_LIMIT);
}

export function parseOffset(raw: unknown): number | undefined {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

/** Pulls `?page=` / `?pageSize=` off a request; the model clamps both. */
export function pageParams(req: Request): { page?: number; pageSize?: number } {
  const page = Number(req.query.page);
  const pageSize = Number(req.query.pageSize);
  return {
    page: Number.isFinite(page) ? page : undefined,
    // A caller that never asked for a page is a pre-pagination client
    // expecting the whole list, so it keeps the 200-row cap it shipped with —
    // the model's own default of 25 would silently truncate it. See pagedBody.
    pageSize: Number.isFinite(pageSize) ? pageSize : req.query.page === undefined ? 200 : undefined,
  };
}

/**
 * Shapes a paged result for the response.
 *
 * The Android app bundles its own copy of the web client (`webDir: 'dist'` in
 * capacitor.config.ts), so an installed APK keeps calling this API with the
 * code it shipped with — deploying the website does not fix it. Builds from
 * before pagination read these bodies as a bare array and would crash on an
 * envelope.
 *
 * So the envelope is opt-in: a request that asks for a page gets
 * `{ data, meta }`; one that does not gets the plain array those builds
 * expect. Once no pre-pagination APK is still in the field, delete this and
 * return `{ data, meta }` unconditionally.
 */
export function pagedBody<T>(req: Request, result: Paged<T>): T[] | { data: T[]; meta: PageMeta } {
  if (req.query.page === undefined) return result.rows;
  const { rows, ...meta } = result;
  return { data: rows, meta };
}
