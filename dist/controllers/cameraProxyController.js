"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cameraProxy = cameraProxy;
const http_1 = __importDefault(require("http"));
const https_1 = __importDefault(require("https"));
const jwt_1 = require("../utils/jwt");
const net_1 = require("../utils/net");
const errors_1 = require("../utils/errors");
/**
 * Streams a LAN camera (e.g. the IP Webcam Android app's MJPEG endpoint,
 * http://<phone-ip>:8080/video) through the API so the browser sees it as
 * same-origin — otherwise the canvas is tainted and face-api.js cannot read
 * pixels. <img>/<video> tags can't send an Authorization header, so the JWT
 * access token is passed as a query parameter instead.
 */
async function cameraProxy(req, res) {
    (0, jwt_1.verifyAccessToken)(String(req.query.token ?? '')); // throws 401 if missing/invalid
    const url = String(req.query.url ?? '');
    if (!(0, net_1.isPrivateHttpUrl)(url)) {
        throw (0, errors_1.badRequest)('Only local-network camera URLs (e.g. http://192.168.x.x:8080/video) are allowed');
    }
    const mod = url.startsWith('https') ? https_1.default : http_1.default;
    const upstream = mod.get(url, { timeout: 10_000 }, (up) => {
        res.status(up.statusCode ?? 200);
        if (up.headers['content-type'])
            res.setHeader('content-type', up.headers['content-type']);
        res.setHeader('cache-control', 'no-store');
        up.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('camera timeout')));
    upstream.on('error', (err) => {
        if (!res.headersSent) {
            res.status(502).json({ error: `Camera unreachable: ${err.message}` });
        }
        else {
            res.end();
        }
    });
    // stop pulling from the phone when the browser tab goes away
    req.on('close', () => upstream.destroy());
}
//# sourceMappingURL=cameraProxyController.js.map