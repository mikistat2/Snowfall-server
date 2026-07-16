"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = __importDefault(require("http"));
const path_1 = __importDefault(require("path"));
const app_1 = require("./app");
const env_1 = require("./config/env");
const knex_1 = require("./db/knex");
const sockets_1 = require("./sockets");
const jobs_1 = require("./jobs");
const botManager_1 = require("./telegram/botManager");
/**
 * Boot: run pending migrations (so Render deploys migrate automatically —
 * tsc compiles src/db/migrations to dist/db/migrations), then start HTTP +
 * Socket.io + cron jobs + Telegram bots.
 */
async function main() {
    if (env_1.env.autoMigrate) {
        const isTs = __filename.endsWith('.ts'); // tsx in dev, compiled js in prod
        const [batch, migrations] = await knex_1.db.migrate.latest({
            directory: path_1.default.join(__dirname, 'db', 'migrations'),
            loadExtensions: [isTs ? '.ts' : '.js'],
            tableName: 'knex_migrations',
        });
        if (migrations.length > 0) {
            // eslint-disable-next-line no-console
            console.log(`[db] migrated batch ${batch}: ${migrations.join(', ')}`);
        }
    }
    const app = (0, app_1.createApp)();
    const server = http_1.default.createServer(app);
    (0, sockets_1.initSocket)(server, env_1.env.corsOrigins);
    (0, jobs_1.startJobs)();
    void (0, botManager_1.initBots)().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[telegram] bot init failed', err);
    });
    server.listen(env_1.env.port, () => {
        // eslint-disable-next-line no-console
        console.log(`API listening on http://localhost:${env_1.env.port} (origins: ${env_1.env.corsOrigins.join(', ')})`);
    });
}
void main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Fatal startup error', err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map