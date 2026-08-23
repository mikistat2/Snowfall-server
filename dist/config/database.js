"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.knexConfig = exports.dbAutosuspends = void 0;
exports.buildConnection = buildConnection;
const env_1 = require("./env");
const activity_1 = require("../utils/activity");
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
function buildConnection() {
    const url = env_1.env.databaseUrl;
    if (url) {
        const needsSsl = /sslmode=require/i.test(url) || MANAGED_DB_HOSTS.test(url);
        return needsSsl
            ? { connectionString: url, ssl: { rejectUnauthorized: false } }
            : { connectionString: url };
    }
    return {
        host: env_1.env.db.host,
        port: env_1.env.db.port,
        user: env_1.env.db.user,
        password: env_1.env.db.password,
        database: env_1.env.db.database,
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
exports.dbAutosuspends = /neon\.tech/i.test(env_1.env.databaseUrl ?? '');
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
exports.knexConfig = {
    client: 'pg',
    connection: buildConnection(),
    pool: {
        min: 0,
        max: 10,
        idleTimeoutMillis: exports.dbAutosuspends ? activity_1.KEEPALIVE_INTERVAL_MINUTES * 60_000 + 60_000 : 30_000,
    },
};
//# sourceMappingURL=database.js.map