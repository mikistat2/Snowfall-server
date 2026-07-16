import http from 'http';
import path from 'path';
import { createApp } from './app';
import { env } from './config/env';
import { db } from './db/knex';
import { initSocket } from './sockets';
import { startJobs } from './jobs';
import { initBots } from './telegram/botManager';

/**
 * Boot: run pending migrations (so Render deploys migrate automatically —
 * tsc compiles src/db/migrations to dist/db/migrations), then start HTTP +
 * Socket.io + cron jobs + Telegram bots.
 */
async function main(): Promise<void> {
  if (env.autoMigrate) {
    const isTs = __filename.endsWith('.ts'); // tsx in dev, compiled js in prod
    const [batch, migrations] = await db.migrate.latest({
      directory: path.join(__dirname, 'db', 'migrations'),
      loadExtensions: [isTs ? '.ts' : '.js'],
      tableName: 'knex_migrations',
    });
    if ((migrations as string[]).length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[db] migrated batch ${batch}: ${(migrations as string[]).join(', ')}`);
    }
  }

  const app = createApp();
  const server = http.createServer(app);

  initSocket(server, env.corsOrigins);
  startJobs();
  void initBots().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[telegram] bot init failed', err);
  });

  server.listen(env.port, () => {
    // eslint-disable-next-line no-console
    console.log(`API listening on http://localhost:${env.port} (origins: ${env.corsOrigins.join(', ')})`);
  });
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error', err);
  process.exit(1);
});
