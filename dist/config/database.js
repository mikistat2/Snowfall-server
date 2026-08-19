"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.knexConfig = void 0;
exports.buildConnection = buildConnection;
const env_1 = require("./env");
const activity_1 = require("../utils/activity");
/**
 * Shared Knex connection config (used by the app AND the knex CLI).
 *
 * Neon/hosted Postgres: set DATABASE_URL to the connection string. SSL is
 * enabled automatically when the URL asks for it (sslmode=require) or the
 * host is a known managed provider. Pool min is 0 so idle connections don't
 * block Neon's autosuspend or die holding the pool.
 */
function buildConnection() {
    const url = env_1.env.databaseUrl;
    if (url) {
        const needsSsl = /sslmode=require/i.test(url) || /neon\.tech|render\.com|supabase\.co/i.test(url);
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
exports.knexConfig = {
    client: 'pg',
    connection: buildConnection(),
    pool: {
        min: 0,
        max: 10,
        idleTimeoutMillis: activity_1.KEEPALIVE_INTERVAL_MINUTES * 60_000 + 60_000,
    },
};
//# sourceMappingURL=database.js.map