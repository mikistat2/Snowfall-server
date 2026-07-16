import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import { api } from './routes';
import { errorHandler } from './middleware/error';

export function createApp(): express.Express {
  const app = express();

  // Render/Vercel sit behind a reverse proxy — needed for correct client IPs
  // (rate limiting) and secure-cookie detection.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '10mb' })); // face descriptors + photo data URLs

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/v1', api);

  app.use(errorHandler);
  return app;
}
