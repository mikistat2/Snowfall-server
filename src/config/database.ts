import type { Knex } from 'knex';
import { env } from './env';

/**
 * Shared Knex connection config (used by the app AND the knex CLI).
 *
 * Neon/hosted Postgres: set DATABASE_URL to the connection string. SSL is
 * enabled automatically when the URL asks for it (sslmode=require) or the
 * host is a known managed provider. Pool min is 0 so idle connections don't
 * block Neon's autosuspend or die holding the pool.
 */
export function buildConnection(): Knex.Config['connection'] {
  const url = env.databaseUrl;
  if (url) {
    const needsSsl =
      /sslmode=require/i.test(url) || /neon\.tech|render\.com|supabase\.co/i.test(url);
    return needsSsl
      ? { connectionString: url, ssl: { rejectUnauthorized: false } }
      : { connectionString: url };
  }
  return {
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
  };
}

export const knexConfig: Knex.Config = {
  client: 'pg',
  connection: buildConnection(),
  pool: { min: 0, max: 10 },
};
