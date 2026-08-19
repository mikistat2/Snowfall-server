import type { Knex } from 'knex';
import { env } from './env';
import { KEEPALIVE_INTERVAL_MINUTES } from '../utils/activity';

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

/**
 * `min: 0` on purpose: a connection held open against a suspended Neon compute
 * gets torn down and reconnected, and every reconnect wakes the compute — which
 * is exactly the bill we are trying not to pay overnight.
 *
 * `idleTimeoutMillis` is instead raised above the keep-alive interval
 * (KEEPALIVE_INTERVAL_MINUTES), so while the app is in use the warm ping's own
 * connection never idles out and real requests reuse it, arriving to an already
 * established TLS session rather than paying a handshake. Once traffic stops
 * the ping stops, the pool drains to zero, and Neon is free to suspend.
 */
export const knexConfig: Knex.Config = {
  client: 'pg',
  connection: buildConnection(),
  pool: {
    min: 0,
    max: 10,
    idleTimeoutMillis: KEEPALIVE_INTERVAL_MINUTES * 60_000 + 60_000,
  },
};
