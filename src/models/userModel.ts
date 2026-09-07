import type { Knex } from 'knex';
import { db } from '../db/knex';
import type { UserRow } from '../types';

/**
 * Staff accounts.
 *
 * Removal is a tombstone, not a DELETE (see the 20260907000015 migration): the
 * row stays so `payments.marked_by` still resolves to a name. Everything that
 * asks "is there a user" therefore has to say `deleted_at IS NULL`. The one
 * exception is `findAnyById`, for the platform panel — the only screen that
 * can restore an account, and it cannot restore what it cannot see.
 * (platformModel.gymStaff is the matching unfiltered list for that screen.)
 */

export async function findByEmail(email: string): Promise<UserRow | undefined> {
  return db('users').whereRaw('lower(email) = lower(?)', [email]).whereNull('deleted_at').first();
}

export async function findById(id: number): Promise<UserRow | undefined> {
  return db('users').where({ id }).whereNull('deleted_at').first();
}

/** Including removed accounts — platform panel only (restore needs the row). */
export async function findAnyById(id: number): Promise<UserRow | undefined> {
  return db('users').where({ id }).first();
}

export async function listByGym(gymId: number): Promise<Omit<UserRow, 'password_hash'>[]> {
  return db('users')
    .where({ gym_id: gymId })
    .whereNull('deleted_at')
    .select('id', 'gym_id', 'name', 'phone', 'email', 'role', 'created_at')
    .orderBy('id');
}

/**
 * Access-token holders are not re-checked per request (`requireAuth` only
 * verifies the signature), so without this a removed account keeps working for
 * the remaining life of its access token — up to 15 minutes of a locked-out
 * employee still using the system. blockFrozenGym calls it on every
 * authenticated request; see the note there about the cost.
 */
export async function isLive(id: number): Promise<boolean> {
  const row = await db('users').where({ id }).whereNull('deleted_at').first('id');
  return Boolean(row);
}

export async function create(
  data: {
    gym_id: number;
    name: string;
    phone?: string | null;
    email: string;
    password_hash: string;
    role: 'owner' | 'staff';
  },
  trx: Knex = db,
): Promise<UserRow> {
  const [row] = await trx('users').insert(data).returning('*');
  return row;
}

export type RemovalOutcome = 'removed' | 'already-removed' | 'last-owner';

/**
 * Remove an account, refusing to take a gym's last live owner with it — a gym
 * with no owner has nobody who can sign in, nobody who can add staff back, and
 * no recipient for any of the alerts that would explain it.
 *
 * The owner rows are locked before the count is read, and the whole thing is
 * one transaction, because the check is otherwise a lie under concurrency: two
 * requests removing two different owners at the same instant would each see
 * the other still present and both succeed, which is precisely the state the
 * check exists to prevent. `orderBy('id')` fixes the lock order so two such
 * requests queue instead of deadlocking.
 *
 * 'already-removed' rather than a silent success, so a double-click cannot
 * write a second tombstone over the first and lose who removed it and when.
 *
 * Revoking their refresh tokens is the caller's job — a hard delete used to
 * get that for free through ON DELETE CASCADE, and a tombstone does not.
 */
export async function softDelete(gymId: number, id: number, by: string): Promise<RemovalOutcome> {
  return db.transaction(async (trx) => {
    const owners = await trx('users')
      .where({ gym_id: gymId, role: 'owner' })
      .whereNull('deleted_at')
      .orderBy('id')
      .forUpdate()
      .select('id');

    const target = await trx('users')
      .where({ gym_id: gymId, id })
      .whereNull('deleted_at')
      .first<{ role: 'owner' | 'staff' } | undefined>('role');
    if (!target) return 'already-removed';
    if (target.role === 'owner' && owners.length <= 1) return 'last-owner';

    await trx('users').where({ gym_id: gymId, id }).update({ deleted_at: trx.fn.now(), deleted_by: by });
    return 'removed';
  });
}

export type RestoreOutcome = 'restored' | 'already-active' | 'email-taken';

/**
 * Undo. Sessions stay revoked — they sign in again.
 *
 * The email may have been handed to somebody else while this account was
 * removed (that is the whole point of the partial unique index), so a restore
 * can legitimately fail. 23505 is caught here rather than pre-checked alone,
 * because a pre-check has a window: the address can be claimed between the
 * look and the write, and the index is the only thing that actually decides.
 */
export async function restore(gymId: number, id: number): Promise<RestoreOutcome> {
  try {
    const n = await db('users')
      .where({ gym_id: gymId, id })
      .whereNotNull('deleted_at')
      .update({ deleted_at: null, deleted_by: null });
    return n ? 'restored' : 'already-active';
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return 'email-taken';
    throw err;
  }
}

export async function setLinkToken(gymId: number, userId: number, token: string): Promise<void> {
  await db('users').where({ gym_id: gymId, id: userId }).update({ telegram_link_token: token });
}

export async function findByLinkToken(token: string): Promise<UserRow | undefined> {
  return db('users').where({ telegram_link_token: token }).whereNull('deleted_at').first();
}

export async function bindTelegram(userId: number, chatId: number): Promise<void> {
  await db('users').where({ id: userId }).update({ telegram_chat_id: chatId, telegram_link_token: null });
}

/** Owner chat ids for a gym (admin alerts / daily summary). */
export async function ownerChatIds(gymId: number): Promise<number[]> {
  const rows: { telegram_chat_id: number }[] = await db('users')
    .where({ gym_id: gymId, role: 'owner' })
    .whereNull('deleted_at')
    .whereNotNull('telegram_chat_id')
    .select('telegram_chat_id');
  return rows.map((r) => Number(r.telegram_chat_id));
}
