"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toPublic = toPublic;
exports.list = list;
exports.findById = findById;
exports.findByEmail = findByEmail;
exports.create = create;
exports.update = update;
exports.remove = remove;
const knex_1 = require("../db/knex");
function toPublic(row) {
    return {
        id: row.id,
        name: row.name,
        email: row.email,
        permissions: {
            approve: row.can_approve,
            freeze: row.can_freeze,
            renew: row.can_renew,
            export: row.can_export,
        },
        created_at: row.created_at,
    };
}
function toColumns(perms) {
    const cols = {};
    if (perms.approve !== undefined)
        cols.can_approve = perms.approve;
    if (perms.freeze !== undefined)
        cols.can_freeze = perms.freeze;
    if (perms.renew !== undefined)
        cols.can_renew = perms.renew;
    if (perms.export !== undefined)
        cols.can_export = perms.export;
    return cols;
}
async function list() {
    const rows = await (0, knex_1.db)('platform_admins').orderBy('id');
    return rows.map(toPublic);
}
async function findById(id) {
    return (0, knex_1.db)('platform_admins').where({ id }).first();
}
async function findByEmail(email) {
    return (0, knex_1.db)('platform_admins').whereRaw('lower(email) = ?', [email.toLowerCase()]).first();
}
async function create(input) {
    const [row] = await (0, knex_1.db)('platform_admins')
        .insert({
        name: input.name,
        email: input.email.toLowerCase(),
        password_hash: input.passwordHash,
        ...toColumns(input.permissions),
    })
        .returning('*');
    return toPublic(row);
}
async function update(id, patch) {
    const cols = { ...toColumns(patch.permissions ?? {}) };
    if (patch.name !== undefined)
        cols.name = patch.name;
    if (patch.passwordHash !== undefined)
        cols.password_hash = patch.passwordHash;
    if (Object.keys(cols).length === 0) {
        const row = await findById(id);
        return row ? toPublic(row) : undefined;
    }
    const [row] = await (0, knex_1.db)('platform_admins').where({ id }).update(cols).returning('*');
    return row ? toPublic(row) : undefined;
}
async function remove(id) {
    return (await (0, knex_1.db)('platform_admins').where({ id }).delete()) > 0;
}
//# sourceMappingURL=platformAdminModel.js.map