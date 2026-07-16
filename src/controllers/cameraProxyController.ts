import type { Request, Response } from 'express';
import http from 'http';
import https from 'https';
import { verifyAccessToken } from '../utils/jwt';
import { isPrivateHttpUrl } from '../utils/net';
import { badRequest } from '../utils/errors';

/**
 * Streams a LAN camera (e.g. the IP Webcam Android app's MJPEG endpoint,
 * http://<phone-ip>:8080/video) through the API so the browser sees it as
 * same-origin — otherwise the canvas is tainted and face-api.js cannot read
 * pixels. <img>/<video> tags can't send an Authorization header, so the JWT
 * access token is passed as a query parameter instead.
 */
export async function cameraProxy(req: Request, res: Response): Promise<void> {
  verifyAccessToken(String(req.query.token ?? '')); // throws 401 if missing/invalid

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
