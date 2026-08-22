import express from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import { api } from './routes';
import { errorHandler } from './middleware/error';
import { markActivity } from './utils/activity';

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

  // Cheap liveness probe for UptimeRobot — deliberately does NOT touch the
  // database, so a Neon wake-up can never make the monitor report the service
  // as down. Warming the database is the keep-alive job's business, and this
  // route is excluded from activity tracking below so that a monitor ping is
  // never mistaken for a person using the app.
  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use((_req, _res, next) => {
    markActivity();
    next();
  });

  app.use('/api/v1', api);

  app.use(errorHandler);
  return app;
}
