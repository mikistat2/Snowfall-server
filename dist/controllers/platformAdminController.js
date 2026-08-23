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
exports.updateNote = updateNote;
exports.deleteGym = deleteGym;
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
const memberModel = __importStar(require("../models/memberModel"));
const platformAlert = __importStar(require("../services/platformAlertService"));
const auditLogModel = __importStar(require("../models/auditLogModel"));
const botManager = __importStar(require("../telegram/botManager"));
/**
 * Owner alerts (Telegram/email) must never make the admin UI hang: wait at
 * most `ms`, then respond anyway — the alert keeps sending in the background.
 */
async function timeboxed(promise, ms = 4000) {
    return Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => resolve(undefined), ms).unref?.()),
    ]);
}
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
    await platformModel.setStatus(id, 'frozen', note ?? undefined);
    // kill active sessions so the freeze takes effect immediately
    await platformModel.revokeGymSessions(id);
    // tell the owner what happened and why (Telegram + email, best effort)
    const notified = await timeboxed(platformAlert.notifyGymOwners(id, gym.name, 'freeze', note));
    res.json({ ok: true, notified });
}
async function unfreezeGym(req, res) {
    const id = Number(req.params.id);
    const gym = await gymModel.findById(id);
    if (!gym)
        throw (0, errors_1.notFound)('Gym not found');
    await platformModel.setStatus(id, 'active');
    const notified = await timeboxed(platformAlert.notifyGymOwners(id, gym.name, 'unfreeze'));
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
    const body = req.body;
    const updated = await gymModel.setFeatures(id, body);
    if (body.telegram_allowed === false && gym.telegram_allowed) {
        await botManager.stopBot(id);
    }
    else if (body.telegram_allowed === true && !gym.telegram_allowed && updated.telegram_bot_token) {
        await botManager.restartBot(id, updated.telegram_bot_token);
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
            by: req.platform?.isOwner ? 'platform_owner' : 'platform_admin',
        },
    });
    res.json({
        ok: true,
        camera_allowed: updated.camera_allowed,
        telegram_allowed: updated.telegram_allowed,
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
    const ends = await platformModel.approveGym(id);
    const notified = await timeboxed(platformAlert.notifyGymOwners(id, gym.name, 'approve', ends.toDateString()));
    res.json({ ok: true, subscription_ends_at: ends, notified });
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
    const notified = await timeboxed(platformAlert.notifyGymOwners(id, gym.name, 'renew', new Date(ends).toDateString()));
    res.json({ ok: true, subscription_ends_at: ends, notified });
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
    const notified = await timeboxed(platformAlert.notifyGymOwners(id, gym.name, 'delete', note), 8000);
    await platformModel.deleteGym(id);
    res.json({ ok: true, notified });
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