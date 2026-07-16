"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.knexConfig = void 0;
exports.buildConnection = buildConnection;
const env_1 = require("./env");
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
exports.knexConfig = {
    client: 'pg',
    connection: buildConnection(),
    pool: { min: 0, max: 10 },
};
//# sourceMappingURL=database.js.map