"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findById = findById;
exports.create = create;
exports.update = update;
exports.updateSettings = updateSettings;
exports.getSettings = getSettings;
exports.setFeatures = setFeatures;
exports.listAll = listAll;
exports.setComped = setComped;
exports.frozenMessage = frozenMessage;
const knex_1 = require("../db/knex");
const types_1 = require("../types");
async function findById(id, trx = knex_1.db) {
    return trx('gyms').where({ id }).first();
}
async function create(data, trx = knex_1.db) {
    const [row] = await trx('gyms')
        .insert({ ...data, settings: JSON.stringify(types_1.DEFAULT_SETTINGS) })
        .returning('*');
    return row;
}
async function update(id, data) {
    const [row] = await (0, knex_1.db)('gyms').where({ id }).update(data).returning('*');
    return row;
}
async function updateSettings(id, settings) {
    const [row] = await (0, knex_1.db)('gyms')
        .where({ id })
        .update({ settings: JSON.stringify(settings) })
        .returning('*');
    return row;
}
/**
 * The gym's settings as the rest of the server should see them: the owner's
 * stored preferences, narrowed by what the platform currently allows.
 *
 * Camera is the only setting an entitlement can override today, and folding it
 * in here rather than at each call site means every existing consumer — the
 * decision engine, the absence-nudge job, the enrol flow, the monitor's
 * /settings payload — respects a revocation without changes of its own.
 *
 * The owner's raw `camera_enabled` is left untouched in the JSONB, so
 * restoring the entitlement restores their original choice rather than
 * silently turning a camera on for a gym that had switched it off.
 */
function getSettings(gym) {
    const settings = { ...types_1.DEFAULT_SETTINGS, ...gym.settings };
    if (!gym.camera_allowed)
        settings.camera_enabled = false;
    return settings;
}
/** Platform-owner-only. See the 20260822000008 migration. */
async function setFeatures(id, features) {
    const [row] = await (0, knex_1.db)('gyms').where({ id }).update(features).returning('*');
    return row;
}
async function listAll() {
    return (0, knex_1.db)('gyms').select('*');
}
/** Permanent exemption from the subscription paywall (see billingService.hasAccess). */
async function setComped(id, comped) {
    await (0, knex_1.db)('gyms').where({ id }).update({ comped });
}
/**
 * The 403 body a frozen gym's owner actually reads.
 *
 * Three call sites reject a frozen gym — login, refresh and every
 * authenticated request — and each has to carry the admin's reason, or the
 * owner sees a different story depending on which one fired first. Built here
 * so they cannot drift.
 *
 * The reason is the whole point: the freeze alert used to travel only by
 * Telegram and email, both best effort, so an owner with no linked chat and a
 * bounced email was locked out with no explanation at all.
 */
function frozenMessage(gym) {
    const note = gym.freeze_note?.trim();
    if (!note)
        return 'This gym account has been frozen by the platform. Please contact support.';
    return ('This gym account has been frozen by the platform.\n\n' +
        `Reason: ${note}\n\n` +
        'Contact the platform administrator to restore access.');
}
//# sourceMappingURL=gymModel.js.map