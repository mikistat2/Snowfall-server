import type { Request, Response } from 'express';
import http from 'http';
import https from 'https';
import { verifyAccessToken } from '../utils/jwt';
import { isPrivateHttpUrl } from '../utils/net';
import { badRequest, unauthorized } from '../utils/errors';
import * as userModel from '../models/userModel';

/**
 * Streams a LAN camera (e.g. the IP Webcam Android app's MJPEG endpoint,
 * http://<phone-ip>:8080/video) through the API so the browser sees it as
 * same-origin — otherwise the canvas is tainted and face-api.js cannot read
 * pixels. <img>/<video> tags can't send an Authorization header, so the JWT
 * access token is passed as a query parameter instead.
 */
export async function cameraProxy(req: Request, res: Response): Promise<void> {
  const payload = verifyAccessToken(String(req.query.token ?? '')); // throws 401 if missing/invalid
  // This is the one authenticated route that sits outside blockFrozenGym, so
  // it has to make the same check itself: a removed account must not keep
  // opening camera streams for the remaining life of its access token. Only
  // new connections are checked — a stream already flowing runs until the tab
  // closes, which is bounded by the browser rather than by us.
  if (!(await userModel.isLive(payload.sub))) throw unauthorized('Your account has been removed');

  const url = String(req.query.url ?? '');
  if (!isPrivateHttpUrl(url)) {
    throw badRequest('Only local-network camera URLs (e.g. http://192.168.x.x:8080/video) are allowed');
  }

  const mod = url.startsWith('https') ? https : http;
  const upstream = mod.get(url, { timeout: 10_000 }, (up) => {
    res.status(up.statusCode ?? 200);
    if (up.headers['content-type']) res.setHeader('content-type', up.headers['content-type']);
    res.setHeader('cache-control', 'no-store');
    up.pipe(res);
  });

  upstream.on('timeout', () => upstream.destroy(new Error('camera timeout')));
  upstream.on('error', (err) => {
    if (!res.headersSent) {
      res.status(502).json({ error: `Camera unreachable: ${err.message}` });
    } else {
      res.end();
    }
  });
  // stop pulling from the phone when the browser tab goes away
  req.on('close', () => upstream.destroy());
}
