import type { Request, Response, NextFunction } from 'express';
import { NATIVE_ORIGINS } from '../config/env';
import * as staffActivityService from '../services/staffActivityService';
import type { ActivitySource } from '../models/staffActivityModel';

/**
 * Which client a request came from.
 *
 * The Android app is served from the WebView's own scheme, so its requests
 * carry one of the fixed native Origins; the website's carry its own domain.
 * No Origin at all (a same-origin dev proxy, a script) is counted as web —
 * the app always sends one, because every app request is cross-origin.
 *
 * `http://localhost` is on the native list for Capacitor, so a web dev server
 * on a port (`http://localhost:5173`) is deliberately not matched: exact
 * string comparison, not a prefix test.
 */
export function sourceOf(origin: string | undefined): ActivitySource {
  return origin && NATIVE_ORIGINS.includes(origin) ? 'app' : 'web';
}

/**
 * Counts a gym's staff opening the app or the website.
 *
 * Mounted directly after blockFrozenGym, so it only ever sees a live account
 * of an approved, unfrozen gym — and before the paywall, so a gym that has not
 * paid still shows up as using the system, which is exactly when the platform
 * owner wants to know. The platform panel's own routes are mounted earlier and
 * never reach it.
 *
 * Calls next() straight away; recording is fire-and-forget.
 */
export function trackStaffActivity(req: Request, _res: Response, next: NextFunction): void {
  if (req.auth?.sub && req.auth.gymId) {
    staffActivityService.record(req.auth.sub, req.auth.gymId, sourceOf(req.headers.origin));
  }
  next();
}
