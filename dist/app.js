"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
const express_1 = __importDefault(require("express"));
const compression_1 = __importDefault(require("compression"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const env_1 = require("./config/env");
const routes_1 = require("./routes");
const error_1 = require("./middleware/error");
const photoStorage = __importStar(require("./services/photoStorage"));
const activity_1 = require("./utils/activity");
const jobs_1 = require("./jobs");
function createApp() {
    const app = (0, express_1.default)();
    // Render/Vercel sit behind a reverse proxy — needed for correct client IPs
    // (rate limiting) and secure-cookie detection.
    app.set('trust proxy', 1);
    app.use((0, helmet_1.default)());
    // Responses here are JSON, and the largest of them is a wall of float
    // literals (face descriptors, member exports) that gzips several times over.
    // Cheap CPU on Render in exchange for bandwidth on every plan's free tier.
    app.use((0, compression_1.default)());
    app.use((0, cors_1.default)({ origin: env_1.env.corsOrigins, credentials: true }));
    app.use(express_1.default.json({ limit: '10mb' })); // face descriptors + photo data URLs
    /**
     * Member photos, when PHOTO_STORAGE is the local driver.
     *
     * Development only — Render's filesystem is ephemeral, so anything written
     * here is gone on the next deploy. Real deployments set PHOTO_STORAGE to
     * 'supabase' and these bytes are served by the CDN instead, never touching
     * this process. Registered before markActivity because fetching an image is
     * not a signal that a person is using the app.
     *
     * Served with the same one-year lifetime the bucket uses, so the browser
     * caching behaviour under test locally is the behaviour that ships. The URL
     * carries ?v=<photo_version>, which is what makes a replaced photo appear.
     *
     * No authentication, matching the public bucket it stands in for: what keeps
     * a photo private is the unguessable key in its path, not a session.
     */
    if (env_1.env.photos.driver === 'local') {
        app.use('/uploads/photos', express_1.default.static(photoStorage.localRoot(), {
            maxAge: '1y',
            immutable: true,
            // No directory listing: the whole security model is that a photo's key
            // cannot be guessed, and an index would hand over every key at once.
            index: false,
            dotfiles: 'ignore',
            setHeaders: (res) => {
                // helmet defaults every response to Cross-Origin-Resource-Policy:
                // same-origin, which makes the browser refuse to render these in an
                // <img> — the client is served from a different origin than the API
                // in every environment (5173 vs 4001 locally, Vercel vs Render in
                // production). The Supabase bucket these stand in for is public and
                // cross-origin by nature, so this matches what ships.
                res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
            },
        }), 
        // express.static calls next() for a path it cannot find, which would
        // otherwise fall through to the API's catch-all and report a 500 for
        // what is simply a photo that is not there.
        (_req, res) => res.status(404).end());
    }
    // Cheap liveness probe for UptimeRobot — deliberately does NOT touch the
    // database, so a database wake-up can never make the monitor report the service
    // as down. Warming the database is the keep-alive job's business, and this
    // route is excluded from activity tracking below so that a monitor ping is
    // never mistaken for a person using the app.
    app.get('/health', (_req, res) => res.json({ ok: true }));
    /**
     * The daily batch, triggered from outside.
     *
     * Render's free instance sleeps after fifteen idle minutes and takes the
     * cron schedule down with it, so an external scheduler (GitHub Actions,
     * cron-job.org — see .github/workflows/daily-tasks.yml) calls this once a
     * day. The request itself is what wakes the instance.
     *
     * It answers 202 immediately and does the work afterwards: a cold start is
     * most of a minute before this handler is even reached, and free schedulers
     * time out long before a full pass over every gym would finish. The reply
     * only confirms the trigger was accepted — whether the run did anything is
     * in the logs, and the day-claim inside runDailyTasks makes a retry after a
     * timeout harmless.
     *
     * Registered above markActivity so a scheduler ping is never mistaken for a
     * person using the app.
     */
    app.post('/tasks/daily', (req, res) => {
        if (!env_1.env.tasksSecret) {
            res.status(503).json({ error: 'TASKS_SECRET is not configured' });
            return;
        }
        // Compared against a header rather than a query parameter so the secret
        // stays out of proxy and access logs.
        if (req.get('x-tasks-secret') !== env_1.env.tasksSecret) {
            res.status(401).json({ error: 'Bad or missing x-tasks-secret' });
            return;
        }
        res.status(202).json({ accepted: true });
        void (0, jobs_1.runDailyTasks)().catch((err) => {
            // eslint-disable-next-line no-console
            console.error('[tasks] daily batch failed', err);
        });
    });
    app.use((_req, _res, next) => {
        (0, activity_1.markActivity)();
        // Somebody is using the app, so the instance is awake — which on the free
        // plan is the only moment the daily batch is guaranteed to be able to run
        // at all. No-op after the first request of the day, and never awaited, so
        // the page this staff member asked for is not held up by it.
        //
        // Below the /health route on purpose: an uptime monitor pinging a sleeping
        // service should not be what decides that members get messaged.
        (0, jobs_1.runDailyTasksIfDue)();
        next();
    });
    app.use('/api/v1', routes_1.api);
    app.use(error_1.errorHandler);
    return app;
}
//# sourceMappingURL=app.js.map