import express from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import { api } from './routes';
import { errorHandler } from './middleware/error';
import * as photoStorage from './services/photoStorage';
import { markActivity } from './utils/activity';
import { runDailyTasks, runDailyTasksIfDue } from './jobs';

export function createApp(): express.Express {
  const app = express();

  // Render/Vercel sit behind a reverse proxy — needed for correct client IPs
  // (rate limiting) and secure-cookie detection.
  app.set('trust proxy', 1);

  app.use(helmet());
  // Responses here are JSON, and the largest of them is a wall of float
  // literals (face descriptors, member exports) that gzips several times over.
  // Cheap CPU on Render in exchange for bandwidth on every plan's free tier.
  app.use(compression());
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '10mb' })); // face descriptors + photo data URLs

  /**
   * Member photos, when PHOTO_STORAGE is the local driver.
   *
   * Development only — Render's filesystem is ephemeral, so anything written
   * here is gone on the next deploy. Real deployments set PHOTO_STORAGE to
   * 'supabase' and these bytes are served by the CDN instead, never touching
   * this process. Registered before markActivity because fetching an image is
   * not a signal that a person is using the app.
   *
   * Served with the same one-year lifetime the bucket uses, so the browser
   * caching behaviour under test locally is the behaviour that ships. The URL
   * carries ?v=<photo_version>, which is what makes a replaced photo appear.
   *
   * No authentication, matching the public bucket it stands in for: what keeps
   * a photo private is the unguessable key in its path, not a session.
   */
  if (env.photos.driver === 'local') {
    app.use(
      '/uploads/photos',
      express.static(photoStorage.localRoot(), {
        maxAge: '1y',
        immutable: true,
        // No directory listing: the whole security model is that a photo's key
        // cannot be guessed, and an index would hand over every key at once.
        index: false,
        dotfiles: 'ignore',
        setHeaders: (res) => {
          // helmet defaults every response to Cross-Origin-Resource-Policy:
          // same-origin, which makes the browser refuse to render these in an
          // <img> — the client is served from a different origin than the API
          // in every environment (5173 vs 4001 locally, Vercel vs Render in
          // production). The Supabase bucket these stand in for is public and
          // cross-origin by nature, so this matches what ships.
          res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        },
      }),
      // express.static calls next() for a path it cannot find, which would
      // otherwise fall through to the API's catch-all and report a 500 for
      // what is simply a photo that is not there.
      (_req, res) => res.status(404).end(),
    );
  }

  // Cheap liveness probe for UptimeRobot — deliberately does NOT touch the
  // database, so a database wake-up can never make the monitor report the service
  // as down. Warming the database is the keep-alive job's business, and this
  // route is excluded from activity tracking below so that a monitor ping is
  // never mistaken for a person using the app.
  app.get('/health', (_req, res) => res.json({ ok: true }));

  /**
   * The daily batch, triggered from outside.
   *
   * Render's free instance sleeps after fifteen idle minutes and takes the
   * cron schedule down with it, so an external scheduler (GitHub Actions,
   * cron-job.org — see .github/workflows/daily-tasks.yml) calls this once a
   * day. The request itself is what wakes the instance.
   *
   * It answers 202 immediately and does the work afterwards: a cold start is
   * most of a minute before this handler is even reached, and free schedulers
   * time out long before a full pass over every gym would finish. The reply
   * only confirms the trigger was accepted — whether the run did anything is
   * in the logs, and the day-claim inside runDailyTasks makes a retry after a
   * timeout harmless.
   *
   * Registered above markActivity so a scheduler ping is never mistaken for a
   * person using the app.
   */
  app.post('/tasks/daily', (req, res) => {
    if (!env.tasksSecret) {
      res.status(503).json({ error: 'TASKS_SECRET is not configured' });
      return;
    }
    // Compared against a header rather than a query parameter so the secret
    // stays out of proxy and access logs.
    if (req.get('x-tasks-secret') !== env.tasksSecret) {
      res.status(401).json({ error: 'Bad or missing x-tasks-secret' });
      return;
    }
    res.status(202).json({ accepted: true });
    void runDailyTasks().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[tasks] daily batch failed', err);
    });
  });

  app.use((_req, _res, next) => {
    markActivity();
    // Somebody is using the app, so the instance is awake — which on the free
    // plan is the only moment the daily batch is guaranteed to be able to run
    // at all. No-op after the first request of the day, and never awaited, so
    // the page this staff member asked for is not held up by it.
    //
    // Below the /health route on purpose: an uptime monitor pinging a sleeping
    // service should not be what decides that members get messaged.
    runDailyTasksIfDue();
    next();
  });

  app.use('/api/v1', api);

  app.use(errorHandler);
  return app;
}
