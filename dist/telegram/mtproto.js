"use strict";
/**
 * MTProto (GramJS) fallback — Phase 3 OPTIONAL stub, intentionally not
 * implemented. The Bot API (grammY) is the only active channel; this
 * interface exists so `notifications.channel = 'mtproto'` can be wired in
 * later without touching the notifier's call sites.
 *
 * A real implementation would log in with a user account (api_id/api_hash +
 * session string) and message members who never pressed /start on the bot.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.mtprotoChannel = void 0;
exports.mtprotoChannel = {
    channel: 'mtproto',
    isAvailable() {
        return false; // never available until implemented
    },
    async sendMessage() {
        throw new Error('MTProto channel is a stub — not implemented (optional Phase 3 fallback)');
    },
};
//# sourceMappingURL=mtproto.js.map