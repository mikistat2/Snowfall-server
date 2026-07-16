"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const env_1 = require("./config/env");
const routes_1 = require("./routes");
const error_1 = require("./middleware/error");
function createApp() {
    const app = (0, express_1.default)();
    // Render/Vercel sit behind a reverse proxy — needed for correct client IPs
    // (rate limiting) and secure-cookie detection.
    app.set('trust proxy', 1);
    app.use((0, helmet_1.default)());
    app.use((0, cors_1.default)({ origin: env_1.env.corsOrigins, credentials: true }));
    app.use(express_1.default.json({ limit: '10mb' })); // face descriptors + photo data URLs
    app.get('/health', (_req, res) => res.json({ ok: true }));
    app.use('/api/v1', routes_1.api);
    app.use(error_1.errorHandler);
    return app;
}
//# sourceMappingURL=app.js.map