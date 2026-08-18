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
Object.defineProperty(exports, "__esModule", { value: true });
exports.notifyGymOwners = notifyGymOwners;
exports.notifyPlatformAdmin = notifyPlatformAdmin;
exports.runSubscriptionAlerts = runSubscriptionAlerts;
exports.runOwnerRenewalReminders = runOwnerRenewalReminders;
const knex_1 = require("../db/knex");
const env_1 = require("../config/env");
const mailer_1 = require("./mailer");
const notifier = __importStar(require("../telegram/notifier"));
const botManager = __importStar(require("../telegram/botManager"));
const userModel = __importStar(require("../models/userModel"));
const billingModel = __importStar(require("../models/billingModel"));
const MESSAGES = {
    approve: {
        subject: 'Your gym registration has been approved 🎉',
        body: (gym, note) => `🎉 Great news — your gym "${gym}" has been approved on the Snowfall platform!\n\n` +
            `You can now log in with the email and password you registered with.\n` +
            (note ? `Your subscription is valid until ${note}.\n` : '') +
            `\nWelcome aboard!`,
    },
    renew: {
        subject: 'Your subscription has been renewed',
        body: (gym, note) => `✅ The subscription for your gym "${gym}" on Snowfall has been renewed` +
            (note ? ` and is now valid until ${note}` : '') +
            `. Thank you!`,
    },
    freeze: {
        subject: 'Your gym account has been frozen',
        body: (gym, note) => `⚠️ Your gym "${gym}" on Snowfall has been temporarily frozen by the platform administrator.\n\n` +
            (note ? `Reason: ${note}\n\n` : '') +
            `While frozen, staff cannot log in and the system is unavailable. Your data (members, payments, history) is safe and nothing has been deleted.\n\n` +
            `To resolve this, please contact the platform administrator at ${env_1.env.platformAdmin.email}.`,
    },
    unfreeze: {
        subject: 'Your gym account has been reactivated',
        body: (gym) => `✅ Good news — your gym "${gym}" on Snowfall has been reactivated. ` +
            `Staff can log in again and everything is back to normal. Thank you!`,
    },
    delete: {
        subject: 'Your gym account has been removed',
        body: (gym, note) => `Your gym "${gym}" and its data have been permanently removed from the Snowfall platform.\n\n` +
            (note ? `Reason: ${note}\n\n` : '') +
            `If you believe this is a mistake, contact the platform administrator at ${env_1.env.platformAdmin.email}.`,
    },
};
async function notifyGymOwners(gymId, gymName, action, note) {
    const { subject, body } = MESSAGES[action];
    const text = body(gymName, note?.trim() || undefined);
    const result = { telegram: false, email: false };
    // Telegram (gym's own bot → linked owner chats; also logged in
    // `notifications`, so it shows on the gym's Notifications page). For
    // 'delete' this runs before the row cascade-deletes — the chat message
    // still reaches the owner's phone.
    try {
        const hasBot = Boolean(botManager.getBot(gymId));
        const chatIds = hasBot ? await userModel.ownerChatIds(gymId) : [];
        await notifier.sendToOwners(gymId, 'admin_alert', text, { platform_action: action });
        result.telegram = hasBot && chatIds.length > 0;
    }
    catch (err) {
        console.warn(`[platform-alert] telegram alert failed for gym ${gymId}:`, err);
    }
    // Email every owner account of the gym.
    try {
        const transport = (0, mailer_1.getTransport)();
        if (transport) {
            const owners = await (0, knex_1.db)('users')
                .where({ gym_id: gymId, role: 'owner' })
                .select('name', 'email');
            for (const owner of owners) {
                await transport.sendMail({
                    from: `"Snowfall Platform" <${env_1.env.mail.user}>`,
                    to: `"${owner.name}" <${owner.email}>`,
                    replyTo: env_1.env.platformAdmin.email,
                    subject: `[Snowfall] ${subject}`,
                    text,
                });
                result.email = true;
            }
        }
    }
    catch (err) {
        console.warn(`[platform-alert] email alert failed for gym ${gymId}:`, err);
    }
    return result;
}
/** Email the platform admin (you) — new registrations, expiring subscriptions, … */
async function notifyPlatformAdmin(subject, text) {
    try {
        const transport = (0, mailer_1.getTransport)();
        if (!transport)
            return;
        await transport.sendMail({
            from: `"Snowfall Platform" <${env_1.env.mail.user}>`,
            to: env_1.env.platformAdmin.email,
            subject: `[Snowfall Admin] ${subject}`,
            text,
        });
    }
    catch (err) {
        console.warn('[platform-alert] admin email failed:', err);
    }
}
/** Days until a gym's subscription ends that trigger an admin reminder. */
const REMINDER_DAYS = new Set([30, 14, 7, 3, 1, 0]);
/**
 * Daily job: email the platform admin about yearly subscriptions (and free
 * trials) that are about to end or have just ended. Fires at 30/14/7/3/1/0
 * days remaining so the mailbox is not spammed every day.
 */
async function runSubscriptionAlerts() {
    const gyms = await (0, knex_1.db)('gyms')
        .where({ status: 'active' })
        .whereNotNull('subscription_ends_at')
        .select('id', 'name', 'is_trial', 'subscription_ends_at');
    const lines = [];
    for (const gym of gyms) {
        const daysLeft = Math.floor((new Date(gym.subscription_ends_at).getTime() - Date.now()) / 86_400_000);
        if (!REMINDER_DAYS.has(daysLeft))
            continue;
        const kind = gym.is_trial ? 'FREE TRIAL' : 'yearly subscription';
        const when = daysLeft === 0 ? 'ends TODAY' : `ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
        lines.push(`• ${gym.name} (id ${gym.id}) — ${kind} ${when} (${new Date(gym.subscription_ends_at).toDateString()})`);
    }
    if (lines.length === 0)
        return;
    await notifyPlatformAdmin(`${lines.length} gym subscription${lines.length === 1 ? '' : 's'} ending soon`, `The following gyms are approaching the end of their subscription:\n\n${lines.join('\n')}\n\n` +
        `Open your platform panel to renew, freeze or contact them.`);
}
/**
 * Daily job: tell each gym OWNER their subscription is running out, so they
 * can renew themselves on the billing page instead of finding out by being
 * locked out.
 *
 * Silent unless the paywall is on — while payments are off nobody is going to
 * be locked out, and a "renew now" email would be a lie. Comped gyms are
 * skipped for the same reason. Fires on the same 30/14/7/3/1/0 ladder as the
 * admin alert, which also keeps it idempotent if the job runs twice in a day.
 */
async function runOwnerRenewalReminders() {
    const settings = await billingModel.getSettings();
    if (!settings.payments_required)
        return;
    const gyms = await (0, knex_1.db)('gyms')
        .where({ status: 'active', comped: false })
        .whereNotNull('subscription_ends_at')
        .select('id', 'name', 'is_trial', 'subscription_ends_at');
    for (const gym of gyms) {
        const endsAt = new Date(gym.subscription_ends_at);
        const daysLeft = Math.floor((endsAt.getTime() - Date.now()) / 86_400_000);
        if (!REMINDER_DAYS.has(daysLeft))
            continue;
        const what = gym.is_trial ? 'free trial' : 'subscription';
        const when = daysLeft === 0
            ? `ends TODAY (${endsAt.toDateString()})`
            : `ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}, on ${endsAt.toDateString()}`;
        const grace = settings.grace_days > 0
            ? `\n\nYou have ${settings.grace_days} day${settings.grace_days === 1 ? '' : 's'} of grace after that date before access stops.`
            : '\n\nAccess stops on that date until a payment is verified.';
        const text = `Your ${what} for "${gym.name}" on Snowfall ${when}.\n\n` +
            `To keep going, log in and open the Billing page. You will find your payment code, the account to ` +
            `send the money to, and the exact amount. Paste the transaction ID or upload the receipt screenshot ` +
            `and your subscription extends immediately — no waiting for us.${grace}`;
        try {
            await notifier.sendToOwners(gym.id, 'admin_alert', text, { subscription_days_left: daysLeft });
        }
        catch (err) {
            console.warn(`[platform-alert] renewal telegram failed for gym ${gym.id}:`, err);
        }
        try {
            const transport = (0, mailer_1.getTransport)();
            if (!transport)
                continue;
            const owners = await (0, knex_1.db)('users')
                .where({ gym_id: gym.id, role: 'owner' })
                .select('name', 'email');
            for (const owner of owners) {
                await transport.sendMail({
                    from: `"Snowfall Platform" <${env_1.env.mail.user}>`,
                    to: `"${owner.name}" <${owner.email}>`,
                    replyTo: env_1.env.platformAdmin.email,
                    subject: `[Snowfall] Your ${what} ${daysLeft === 0 ? 'ends today' : `ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`}`,
                    text,
                });
            }
        }
        catch (err) {
            console.warn(`[platform-alert] renewal email failed for gym ${gym.id}:`, err);
        }
    }
}
//# sourceMappingURL=platformAlertService.js.map