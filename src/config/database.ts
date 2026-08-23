import type { Knex } from 'knex';
import { env } from './env';
import { KEEPALIVE_INTERVAL_MINUTES } from '../utils/activity';

/** Minimal shape of the node-postgres connection knex hands to afterCreate. */
interface PgConnection {
  query(sql: string, cb: (err: Error | null) => void): void;
}

/**
 * Hosts whose Postgres always requires TLS, even when the pasted connection
 * string forgot to say `sslmode=require`.
 *
 * Supabase publishes two shapes: the direct host `db.<ref>.supabase.co` and
 * the poolers `<region>.pooler.supabase.com` — hence both TLDs.
 */
const MANAGED_DB_HOSTS = /neon\.tech|render\.com|supabase\.(co|com)/i;

/**
 * Shared Knex connection config (used by the app AND the knex CLI).
 *
 * Hosted Postgres: set DATABASE_URL to the connection string. SSL is enabled
 * automatically when the URL asks for it (sslmode=require) or the host is one
 * of the managed providers above.
 *
 * On Supabase, use a **pooler** string (`...pooler.supabase.com`), not the
 * direct `db.<ref>.supabase.co` host: the direct host resolves to IPv6 only
 * and Render's outbound traffic is IPv4, so it fails to connect at all.
 * Port 5432 on the pooler is session mode (a real Postgres session per
 * connection — what Knex, migrations and `SET`-based features expect);
 * port 6543 is transaction mode and drops session state between statements.
 */
export function buildConnection(): Knex.Config['connection'] {
  const url = env.databaseUrl;
  if (url) {
    const needsSsl = /sslmode=require/i.test(url) || MANAGED_DB_HOSTS.test(url);
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
 * True when the provider suspends its compute after a few idle minutes and
 * bills for the time it is awake. That is Neon's model, and the only reason
 * the keep-alive cron in `jobs/index.ts` exists.
 *
 * Supabase keeps the instance running, so a ping every few minutes buys
 * nothing. (Its free plan pauses a project after seven days with *no* traffic
 * — which a keep-alive gated on real activity could never prevent anyway,
 * since by then there is no activity to gate on.)
 */
export const dbAutosuspends = /neon\.tech/i.test(env.databaseUrl ?? '');

/**
 * `min: 0` on purpose: an idle connection held against a suspended compute
 * gets torn down and reconnected, and every reconnect wakes that compute.
 * It also keeps the pool from sitting on connections a pooled provider counts
 * against a per-project limit.
 *
 * `idleTimeoutMillis` is raised above the keep-alive interval on an
 * autosuspending provider only, so the warm ping's own connection never idles
 * out and real requests reuse it, arriving to an already established TLS
 * session rather than paying a handshake. Once traffic stops the ping stops,
 * the pool drains to zero, and the compute is free to suspend. With no
 * keep-alive running there is nothing to hold the connection open *for*, so
 * idle connections are released promptly instead.
 */
export const knexConfig: Knex.Config = {
  client: 'pg',
  connection: buildConnection(),
  pool: {
    min: 0,
    max: 10,
    idleTimeoutMillis: dbAutosuspends ? KEEPALIVE_INTERVAL_MINUTES * 60_000 + 60_000 : 30_000,
    afterCreate: (conn: PgConnection, done: (err: Error | null, conn: PgConnection) => void) => {
      // Supabase's pooler hands out sessions with extra_float_digits = 0, where
      // Postgres' own default (and Neon's) is 1. At 0 a float4 renders with six
      // significant digits instead of the shortest string that round-trips, and
      // node-postgres parses the TEXT form — so the app would receive 0.243376
      // for a check-in confidence stored as 0.24337596, and similarly rounded
      // face descriptors.
      //
      // Nothing depends on that last digit (a float4 carries ~7 either way, and
      // the face-match threshold is ~0.5), but it is a silent difference in what
      // the same row returns depending on who is hosting it. One statement per
      // connection removes it.
      conn.query('SET extra_float_digits = 1', (err: Error | null) => done(err, conn));
    },
  },
};
