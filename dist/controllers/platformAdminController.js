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
exports.login = login;
exports.me = me;
exports.overview = overview;
exports.listGyms = listGyms;
exports.gymDetail = gymDetail;
exports.freezeGym = freezeGym;
exports.unfreezeGym = unfreezeGym;
exports.setFeatures = setFeatures;
exports.exportGymMembers = exportGymMembers;
exports.exportAllMembers = exportAllMembers;
exports.getSettings = getSettings;
exports.updateSettings = updateSettings;
exports.approveGym = approveGym;
exports.renewGym = renewGym;
exports.setTrial = setTrial;
exports.updateNote = updateNote;
exports.deleteGym = deleteGym;
exports.deleteStaff = deleteStaff;
exports.restoreStaff = restoreStaff;
exports.listAdmins = listAdmins;
exports.createAdmin = createAdmin;
exports.updateAdmin = updateAdmin;
exports.removeAdmin = removeAdmin;
const crypto_1 = __importDefault(require("crypto"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const env_1 = require("../config/env");
const jwt_1 = require("../utils/jwt");
const errors_1 = require("../utils/errors");
const platformModel = __importStar(require("../models/platformModel"));
const platformAdminModel = __importStar(require("../models/platformAdminModel"));
const gymModel = __importStar(require("../models/gymModel"));
const userModel = __importStar(require("../models/userModel"));
const refreshTokenModel = __importStar(require("../models/refreshTokenModel"));
const featureNoticeModel = __importStar(require("../models/featureNoticeModel"));
const memberModel = __importStar(require("../models/memberModel"));
const platformAlert = __importStar(require("../services/platformAlertService"));
const auditLogModel = __importStar(require("../models/auditLogModel"));
const botManager = __importStar(require("../telegram/botManager"));
// Owner alerts (Telegram/email) must never make the admin UI hang: wait at
// most `ms`, then respond anyway — the alert keeps sending in the background.
const async_1 = require("../utils/async");
function safeEqual(a, b) {
    const ha = crypto_1.default.createHash('sha256').update(a).digest();
    const hb = crypto_1.default.createHash('sha256').update(b).digest();
    return crypto_1.default.timingSafeEqual(ha, hb);
}
async function login(req, res) {
    const { email, password } = req.body;
    if (!env_1.env.platformAdmin.password) {
        throw new errors_1.AppError(503, 'Platform admin is not configured (set PLATFORM_ADMIN_PASSWORD)');
    }
    // the product owner (env credentials) — full access
    if (safeEqual(email.toLowerCase(), env_1.env.platformAdmin.email.toLowerCase()) && safeEqual(password, env_1.env.platformAdmin.password)) {
        res.json({
            token: (0, jwt_1.signPlatformToken)(),
            email: env_1.env.platformAdmin.email,
            role: 'owner',
            name: 'Platform Owner',
            permissions: { approve: true, freeze: true, renew: true, export: true },
        });
        return;
    }
    // sub-admins created by the owner — limited access
    const admin = await platformAdminModel.findByEmail(email);
    if (!admin || !(await bcryptjs_1.default.compare(password, admin.password_hash))) {
        throw (0, errors_1.unauthorized)('Invalid email or password');
    }
    const pub = platformAdminModel.toPublic(admin);
    res.json({
        token: (0, jwt_1.signPlatformToken)(admin.id, admin.name),
        email: admin.email,
        role: 'admin',
        name: admin.name,
        permissions: pub.permissions,
    });
}
/** Current session: role + live permissions (the UI re-syncs from this). */
async function me(req, res) {
    const p = req.platform;
    res.json({
        role: p.isOwner ? 'owner' : 'admin',
        name: p.name,
        permissions: p.permissions,
    });
}
async function overview(_req, res) {
    res.json(await platformModel.overview());
}
async function listGyms(req, res) {
    res.json(await platformModel.listGyms(req.query.search));
}
async function gymDetail(req, res) {
    const id = Number(req.params.id);
    const [gyms, staff] = await Promise.all([platformModel.listGyms(), platformModel.gymStaff(id)]);
    const gym = gyms.find((g) => g.id === id);
    if (!gym)
        throw (0, errors_1.notFound)('Gym not found');
    res.json({ ...gym, staff });
}
async function freezeGym(req, res) {
    const id = Number(req.params.id);
    const gym = await gymModel.findById(id);
    if (!gym)
        throw (0, errors_1.notFound)('Gym not found');
    const note = req.body.note;
    // Stored on the gym, so every later 403 can quote it — that is the only
    // channel guaranteed to reach the owner. Safe to call on an already-frozen
    // gym: it rewrites the reason and leaves status and frozen_at alone.
    await platformModel.setStatus(id, 'frozen', note ?? undefined);
    // kill active sessions so the freeze takes effect immediately
    await platformModel.revokeGymSessions(id);
    // push the same reason out of band too (Telegram + email, best effort)
    const notified = await (0, async_1.timeboxed)(platformAlert.notifyGymOwners(id, gym.name, 'freeze', note));
    res.json({ ok: true, notified });
}
async function unfreezeGym(req, res) {
    const id = Number(req.params.id);
    const gym = await gymModel.findById(id);
    if (!gym)
        throw (0, errors_1.notFound)('Gym not found');
    await platformModel.setStatus(id, 'active');
    const notified = await (0, async_1.timeboxed)(platformAlert.notifyGymOwners(id, gym.name, 'unfreeze'));
    res.json({ ok: true, notified });
}
/**
 * Grant or revoke a gym's platform features (owner-only).
 *
 * Revoking is a lock, never a delete: enrolled face descriptors and the stored
 * bot token both survive, so restoring the entitlement brings the gym back
 * exactly as it was. Freeing that storage is a separate, deliberate act.
 *
 * Revoking Telegram stops the running bot in the same request rather than
 * waiting for the next boot — otherwise a revoked gym keeps sending messages
 * until the server restarts.
 */
async function setFeatures(req, res) {
    const id = Number(req.params.id);
    const gym = await gymModel.findById(id);
    if (!gym)
        throw (0, errors_1.notFound)('Gym not found');
    const { note, ...body } = req.body;
    const changedBy = req.platform?.isOwner ? 'Platform Owner' : (req.platform?.name ?? 'Platform admin');
    // Only the entitlements that actually MOVED produce a notice. Re-sending the
    // current value (a double-click, a stale panel) must not raise a fresh alert
    // for a change that did not happen.
    const changes = [];
    if (body.camera_allowed !== undefined && body.camera_allowed !== gym.camera_allowed) {
        changes.push({ feature: 'camera', allowed: body.camera_allowed });
    }
    if (body.telegram_allowed !== undefined && body.telegram_allowed !== gym.telegram_allowed) {
        changes.push({ feature: 'telegram', allowed: body.telegram_allowed });
    }
    const updated = await gymModel.setFeatures(id, body);
    // The in-app notice is the channel that cannot fail: it is a row, not a
    // delivery attempt, so the owner sees it on their next load even with no bot
    // linked and no mail server configured.
    for (const change of changes) {
        await featureNoticeModel.create({
            gym_id: id,
            feature: change.feature,
            allowed: change.allowed,
            note,
            changed_by: changedBy,
        });
    }
    // The bot is bracketed around the alert, not sequenced after it, because the
    // alert about Telegram wants to go out OVER Telegram:
    //   granting  → start the bot first, so the good news has a bot to go out on;
    //   revoking  → stop it afterwards, so the explanation is not swallowed by
    //               the very shutdown it is explaining.
    if (body.telegram_allowed === true && !gym.telegram_allowed && updated.telegram_bot_token) {
        await botManager.restartBot(id, updated.telegram_bot_token);
    }
    // A revocation waits longer for the send to land before killing the bot;
    // nothing is racing the other cases, so they respond on the usual timebox.
    const revokingTelegram = changes.some((c) => c.feature === 'telegram' && !c.allowed);
    const alerts = Promise.all(changes.map((c) => platformAlert.notifyFeatureChange(id, gym.name, c.feature, c.allowed, note)));
    const notified = (await (0, async_1.timeboxed)(alerts, revokingTelegram ? 8000 : 4000))?.at(-1);
    if (body.telegram_allowed === false && gym.telegram_allowed) {
        await botManager.stopBot(id);
    }
    // Revoking the camera can strand staff on the monitor page with a live token
    // and a now-403 recognition loop; the audit trail is what explains it.
    await auditLogModel.log({
        gym_id: id,
        user_id: null,
        action: 'platform.features_updated',
        entity: 'gym',
        entity_id: id,
        meta: {
            camera_allowed: updated.camera_allowed,
            telegram_allowed: updated.telegram_allowed,
            changed: changes.map((c) => `${c.feature}:${c.allowed ? 'on' : 'off'}`),
            note: note?.trim() || null,
            by: req.platform?.isOwner ? 'platform_owner' : 'platform_admin',
        },
    });
    res.json({
        ok: true,
        camera_allowed: updated.camera_allowed,
        telegram_allowed: updated.telegram_allowed,
        changed: changes.length,
        notified,
    });
}
/** Full member dump of ONE gym — the client renders it as that gym's members PDF. */
async function exportGymMembers(req, res) {
    const id = Number(req.params.id);
    const gym = await gymModel.findById(id);
    if (!gym)
        throw (0, errors_1.notFound)('Gym not found');
    res.json({ gym_name: gym.name, members: await memberModel.exportByGym(id) });
}
/** Full member dump of every registered gym — the client renders it as a backup PDF. */
async function exportAllMembers(_req, res) {
    const gyms = await platformModel.listGyms();
    const result = [];
    for (const gym of gyms) {
        result.push({ gym, members: await memberModel.exportByGym(gym.id) });
    }
    res.json(result);
}
async function getSettings(_req, res) {
    res.json(await platformModel.getSettings());
}
async function updateSettings(req, res) {
    res.json(await platformModel.updateSettings(req.body));
}
/** Approve a pending registration: activate + start the paid year. */
async function approveGym(req, res) {
    const id = Number(req.params.id);
    const gym = await gymModel.findById(id);
    if (!gym)
        throw (0, errors_1.notFound)('Gym not found');
    if (gym.status !== 'pending')
        throw (0, errors_1.forbidden)('Only pending registrations can be approved');
    // The admin's choice wins; otherwise honour the cycle the gym picked when it
    // registered, and fall back to a year — which is what approval always did.
    const cycle = req.body.cycle ?? gym.billing_cycle ?? 'YEARLY';
    const ends = await platformModel.approveGym(id, cycle);
    const notified = await (0, async_1.timeboxed)(platformAlert.notifyGymOwners(id, gym.name, 'approve', ends.toDateString()));
    res.json({ ok: true, subscription_ends_at: ends, cycle, notified });
}
/**
 * Extend the subscription by one month or one year (also converts a trial to
 * paid). No payment row is written here — this is the goodwill/free path. To
 * convert a trial AND keep a record of the money, use
 * POST /gyms/:id/record-payment instead.
 *
 * A trial conversion defaults to starting today: the days left on a free trial
 * are not something the gym paid for, so they are not carried into the paid
 * period unless the caller explicitly asks.
 */
async function renewGym(req, res) {
    const id = Number(req.params.id);
    const gym = await gymModel.findById(id);
    if (!gym)
        throw (0, errors_1.notFound)('Gym not found');
    if (gym.status === 'pending')
        throw (0, errors_1.forbidden)('Approve the registration first');
    const { cycle = 'YEARLY', fromNow } = req.body;
    const ends = await platformModel.renewGym(id, cycle, fromNow ?? gym.is_trial);
    const notified = await (0, async_1.timeboxed)(platformAlert.notifyGymOwners(id, gym.name, 'renew', new Date(ends).toDateString()));
    res.json({ ok: true, subscription_ends_at: ends, notified });
}
/**
 * Move a gym onto a free trial — the undo for an accidental renewal, and the
 * way to start a gym on a trial that registered before trial mode was on.
 *
 * Deliberately NOT alerted to the owner. Every other platform action here
 * tells them something they gain; this one usually SHORTENS their end date
 * while correcting an internal mistake, and "your subscription now ends in 30
 * days instead of a year" is an alarming message to send about a clerical
 * fix. It is audited instead, so the change is still traceable.
 */
async function setTrial(req, res) {
    const id = Number(req.params.id);
    const gym = await gymModel.findById(id);
    if (!gym)
        throw (0, errors_1.notFound)('Gym not found');
    if (gym.status === 'pending')
        throw (0, errors_1.forbidden)('Approve the registration first');
    const { days } = req.body;
    const endsAt = await platformModel.setTrial(id, days);
    await auditLogModel.log({
        gym_id: id,
        user_id: null,
        action: 'platform.trial_set',
        entity: 'gym',
        entity_id: id,
        meta: {
            days,
            ends_at: new Date(endsAt).toISOString(),
            // What it replaced — without this the log cannot answer "how much time
            // did this take away", which is the only question worth asking of it.
            previous_ends_at: gym.subscription_ends_at,
            previous_is_trial: gym.is_trial,
            previous_comped: gym.comped,
            by: req.platform?.isOwner ? 'platform_owner' : 'platform_admin',
        },
    });
    res.json({ ok: true, subscription_ends_at: endsAt, is_trial: true, comped: false });
}
async function updateNote(req, res) {
    const id = Number(req.params.id);
    const gym = await gymModel.findById(id);
    if (!gym)
        throw (0, errors_1.notFound)('Gym not found');
    await platformModel.setNote(id, req.body.note);
    res.json({ ok: true });
}
async function deleteGym(req, res) {
    const id = Number(req.params.id);
    const gym = await gymModel.findById(id);
    if (!gym)
        throw (0, errors_1.notFound)('Gym not found');
    const { confirm_name, note } = req.body;
    if (confirm_name !== gym.name) {
        throw (0, errors_1.forbidden)('Confirmation name does not match the gym name');
    }
    // alert BEFORE deleting — afterwards the owner accounts are gone
    const notified = await (0, async_1.timeboxed)(platformAlert.notifyGymOwners(id, gym.name, 'delete', note), 8000);
    await platformModel.deleteGym(id);
    res.json({ ok: true, notified });
}
// --------------------------------------- gym staff accounts (owner only) ----
/**
 * Both ids, rejected as "not found" rather than passed to Postgres as NaN —
 * which is a 500 with a type error in it, not an answer.
 */
function staffParams(req) {
    const gymId = Number(req.params.id);
    const userId = Number(req.params.userId);
    if (!Number.isInteger(gymId) || !Number.isInteger(userId)) {
        throw (0, errors_1.notFound)('Staff account not found in this gym');
    }
    return { gymId, userId };
}
/** How this action is attributed in the audit log and on the tombstone. */
function actorLabel(req) {
    return req.platform?.isOwner ? 'Platform Owner' : `Platform admin: ${req.platform?.name ?? 'unknown'}`;
}
/**
 * Remove one gym's staff account.
 *
 * A tombstone, not a DELETE — see the 20260907000015 migration for why a real
 * delete is impossible for anyone who has recorded a payment. What the gym
 * loses is the person's access; what it keeps is everything they did.
 *
 * Owner-only, alongside gym deletion and feature entitlements: reaching into a
 * tenant and closing one of its accounts is a structural act, not one of the
 * day-to-day permissions handed to sub-admins.
 */
async function deleteStaff(req, res) {
    const { gymId, userId } = staffParams(req);
    const gym = await gymModel.findById(gymId);
    if (!gym)
        throw (0, errors_1.notFound)('Gym not found');
    // findAnyById, so an already-removed account reports itself as such instead
    // of as missing — the panel shows those rows and can act on them twice.
    const target = await userModel.findAnyById(userId);
    // The gym_id check is what keeps this from being a cross-tenant delete by
    // way of a mistyped id: the URL names a gym, and the account must be in it.
    if (!target || target.gym_id !== gymId)
        throw (0, errors_1.notFound)('Staff account not found in this gym');
    if (target.deleted_at)
        throw (0, errors_1.conflict)('That account has already been removed');
    const { note } = req.body;
    // The last-owner rule is enforced inside this call rather than by a check
    // out here, so it holds under concurrency — see the note on softDelete. Both
    // refusals below are therefore about state as of the write, not as of a read
    // that has already gone stale.
    const outcome = await userModel.softDelete(gymId, userId, actorLabel(req));
    // A gym with no live owner is unusable and unrecoverable from the tenant
    // side: nobody can sign in, nobody can create staff, and every owner alert
    // has no recipient. Closing a whole gym is what `DELETE /gyms/:id` is for.
    if (outcome === 'last-owner') {
        throw (0, errors_1.forbidden)(`${target.name} is the only owner account of "${gym.name}". Removing it would leave the gym with ` +
            'nobody who can sign in. Add a second owner first, or delete the gym itself.');
    }
    if (outcome === 'already-removed')
        throw (0, errors_1.conflict)('That account has already been removed');
    // The tombstone alone would leave them signed in: revoking is what actually
    // ends the session (blockFrozenGym closes the access-token window).
    await refreshTokenModel.revokeAllForUser(userId);
    await auditLogModel.log({
        gym_id: gymId,
        // Null, not the platform account: audit_logs.user_id is a users FK and the
        // platform admin has no row there. `by` in the meta carries the identity.
        user_id: null,
        action: 'platform.staff_removed',
        entity: 'user',
        entity_id: userId,
        meta: {
            name: target.name,
            email: target.email,
            role: target.role,
            note: note?.trim() || null,
            by: actorLabel(req),
        },
    });
    const notified = await (0, async_1.timeboxed)(platformAlert.notifyStaffRemoved(gymId, gym.name, target, note));
    res.json({ ok: true, notified });
}
/**
 * Put a removed account back.
 *
 * Their sessions stay revoked — restoring access is not the same as handing
 * back a session that was ended, and they still know their password.
 */
async function restoreStaff(req, res) {
    const { gymId, userId } = staffParams(req);
    const gym = await gymModel.findById(gymId);
    if (!gym)
        throw (0, errors_1.notFound)('Gym not found');
    const target = await userModel.findAnyById(userId);
    if (!target || target.gym_id !== gymId)
        throw (0, errors_1.notFound)('Staff account not found in this gym');
    if (!target.deleted_at)
        throw (0, errors_1.conflict)('That account is already active');
    // The partial unique index only covers live rows, so the address may have
    // been handed to somebody else while this one was removed. Asked first, to
    // name the account in the way; the index itself is what decides, and restore
    // reports that back as 'email-taken' if it is claimed in between.
    const clash = await userModel.findByEmail(target.email);
    if (clash) {
        throw (0, errors_1.conflict)(`${target.email} now belongs to another active account (${clash.name}). ` +
            'Change or remove that account before restoring this one.');
    }
    const outcome = await userModel.restore(gymId, userId);
    if (outcome === 'email-taken') {
        throw (0, errors_1.conflict)(`${target.email} was just claimed by another account. Restore is not possible.`);
    }
    if (outcome === 'already-active')
        throw (0, errors_1.conflict)('That account is already active');
    await auditLogModel.log({
        gym_id: gymId,
        user_id: null,
        action: 'platform.staff_restored',
        entity: 'user',
        entity_id: userId,
        meta: {
            name: target.name,
            email: target.email,
            role: target.role,
            removed_at: target.deleted_at,
            removed_by: target.deleted_by,
            by: actorLabel(req),
        },
    });
    res.json({ ok: true });
}
// ------------------------------------------- sub-admin management (owner) ----
async function listAdmins(_req, res) {
    res.json(await platformAdminModel.list());
}
async function createAdmin(req, res) {
    const { name, email, password, permissions } = req.body;
    if (email.toLowerCase() === env_1.env.platformAdmin.email.toLowerCase()) {
        throw (0, errors_1.conflict)('That email is the platform owner account');
    }
    if (await platformAdminModel.findByEmail(email)) {
        throw (0, errors_1.conflict)('An admin with that email already exists');
    }
    const admin = await platformAdminModel.create({
        name,
        email,
        passwordHash: await bcryptjs_1.default.hash(password, 10),
        permissions,
    });
    res.status(201).json(admin);
}
async function updateAdmin(req, res) {
    const id = Number(req.params.id);
    const { name, password, permissions } = req.body;
    const admin = await platformAdminModel.update(id, {
        name,
        passwordHash: password ? await bcryptjs_1.default.hash(password, 10) : undefined,
        permissions,
    });
    if (!admin)
        throw (0, errors_1.notFound)('Admin not found');
    res.json(admin);
}
async function removeAdmin(req, res) {
    const id = Number(req.params.id);
    if (!(await platformAdminModel.remove(id)))
        throw (0, errors_1.notFound)('Admin not found');
    // their token dies on the next request — requirePlatformAdmin re-checks the DB
    res.json({ ok: true });
}
//# sourceMappingURL=platformAdminController.js.map