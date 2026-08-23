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
//# sourceMappingURL=gymModel.js.map