"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isPrivateHttpUrl = isPrivateHttpUrl;
/**
 * SSRF guard for the camera proxy: only plain http(s) URLs pointing at the
 * local machine or a private LAN address may be proxied (IP Webcam and
 * similar apps live on the gym's own Wi-Fi).
 */
function isPrivateHttpUrl(raw) {
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        return false;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.local'))
        return true;
    const octets = host.split('.').map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
        return false; // public hostnames are not allowed
    }
    const [a, b] = octets;
    if (a === 127 || a === 10)
        return true; // loopback / 10.0.0.0/8
    if (a === 192 && b === 168)
        return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31)
        return true; // 172.16.0.0/12
    if (a === 169 && b === 254)
        return true; // link-local
    return false;
}
//# sourceMappingURL=net.js.map