import { db } from '../db/knex';

/**
 * Sub-admin accounts for the platform panel. Only the product owner (env
 * credentials, admin id 0) may create/update/remove rows here.
 */

export interface PlatformAdminPerms {
  approve: boolean;
  freeze: boolean;
  renew: boolean;
  export: boolean;
}

export interface PlatformAdminRow {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  can_approve: boolean;
  can_freeze: boolean;
  can_renew: boolean;
  can_export: boolean;
  created_at: string;
}

export interface PlatformAdminPublic {
  id: number;
  name: string;
  email: string;
  permissions: PlatformAdminPerms;
  created_at: string;
}

export function toPublic(row: PlatformAdminRow): PlatformAdminPublic {
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

function toColumns(perms: Partial<PlatformAdminPerms>): Record<string, boolean> {
  const cols: Record<string, boolean> = {};
  if (perms.approve !== undefined) cols.can_approve = perms.approve;
  if (perms.freeze !== undefined) cols.can_freeze = perms.freeze;
  if (perms.renew !== undefined) cols.can_renew = perms.renew;
  if (perms.export !== undefined) cols.can_export = perms.export;
  return cols;
}

export async function list(): Promise<PlatformAdminPublic[]> {
  const rows = await db<PlatformAdminRow>('platform_admins').orderBy('id');
  return rows.map(toPublic);
}

export async function findById(id: number): Promise<PlatformAdminRow | undefined> {
  return db<PlatformAdminRow>('platform_admins').where({ id }).first();
}

export async function findByEmail(email: string): Promise<PlatformAdminRow | undefined> {
  return db<PlatformAdminRow>('platform_admins').whereRaw('lower(email) = ?', [email.toLowerCase()]).first();
}

export async function create(input: {
  name: string;
  email: string;
  passwordHash: string;
  permissions: PlatformAdminPerms;
}): Promise<PlatformAdminPublic> {
  const [row] = await db<PlatformAdminRow>('platform_admins')
    .insert({
      name: input.name,
      email: input.email.toLowerCase(),
      password_hash: input.passwordHash,
      ...toColumns(input.permissions),
    })
    .returning('*');
  return toPublic(row!);
}

export async function update(
  id: number,
  patch: { name?: string; passwordHash?: string; permissions?: Partial<PlatformAdminPerms> },
): Promise<PlatformAdminPublic | undefined> {
  const cols: Record<string, unknown> = { ...toColumns(patch.permissions ?? {}) };
  if (patch.name !== undefined) cols.name = patch.name;
  if (patch.passwordHash !== undefined) cols.password_hash = patch.passwordHash;
  if (Object.keys(cols).length === 0) {
    const row = await findById(id);
    return row ? toPublic(row) : undefined;
  }
  const [row] = await db<PlatformAdminRow>('platform_admins').where({ id }).update(cols).returning('*');
  return row ? toPublic(row) : undefined;
}

export async function remove(id: number): Promise<boolean> {
  return (await db('platform_admins').where({ id }).delete()) > 0;
}
