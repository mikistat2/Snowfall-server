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
exports.cameraProxy = cameraProxy;
const http_1 = __importDefault(require("http"));
const https_1 = __importDefault(require("https"));
const jwt_1 = require("../utils/jwt");
const net_1 = require("../utils/net");
const errors_1 = require("../utils/errors");
const userModel = __importStar(require("../models/userModel"));
/**
 * Streams a LAN camera (e.g. the IP Webcam Android app's MJPEG endpoint,
 * http://<phone-ip>:8080/video) through the API so the browser sees it as
 * same-origin — otherwise the canvas is tainted and face-api.js cannot read
 * pixels. <img>/<video> tags can't send an Authorization header, so the JWT
 * access token is passed as a query parameter instead.
 */
async function cameraProxy(req, res) {
    const payload = (0, jwt_1.verifyAccessToken)(String(req.query.token ?? '')); // throws 401 if missing/invalid
    // This is the one authenticated route that sits outside blockFrozenGym, so
    // it has to make the same check itself: a removed account must not keep
    // opening camera streams for the remaining life of its access token. Only
    // new connections are checked — a stream already flowing runs until the tab
    // closes, which is bounded by the browser rather than by us.
    if (!(await userModel.isLive(payload.sub)))
        throw (0, errors_1.unauthorized)('Your account has been removed');
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