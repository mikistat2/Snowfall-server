import type { Knex } from 'knex';
import { db } from '../db/knex';
import type { MemberRow, MemberStatus } from '../types';

export interface MemberInput {
  full_name: string;
  phone?: string | null;
  sex?: 'male' | 'female' | null;
  photo_url?: string | null;
}

/**
 * `limit`/`offset` are optional: the desktop table asks for everything, the
 * mobile list pages through. Ordering is by name, which is stable, so paging
 * cannot skip or repeat a row between requests.
 */
export async function listByGym(
  gymId: number,
  filter: { search?: string; status?: MemberStatus; archived?: boolean; limit?: number; offset?: number } = {},
): Promise<(MemberRow & { plan_name: string | null; expires_at: string | null })[]> {
  const q = db('members as m')
    .where('m.gym_id', gymId)
    // archived members are off the roster: they surface only when asked for by
    // name, from the Archived filter
    .modify((b) => (filter.archived ? b.whereNotNull('m.archived_at') : b.whereNull('m.archived_at')))
    .leftJoin(
      db('subscriptions')
        .select('member_id', 'plan_id', 'expires_at')
        .distinctOn('member_id')
        .orderBy(['member_id', { column: 'expires_at', order: 'desc' }])
        .as('s'),
      's.member_id',
      'm.id',
    )
    .leftJoin('plans as p', 'p.id', 's.plan_id')
    .select('m.*', 'p.name as plan_name', 's.expires_at')
    .orderBy('m.full_name');
  if (filter.status) q.andWhere('m.status', filter.status);
  if (filter.search) {
    q.andWhere((b) =>
      b.whereILike('m.full_name', `%${filter.search}%`).orWhereILike('m.phone', `%${filter.search}%`),
    );
  }
  if (filter.limit != null) q.limit(filter.limit);
  if (filter.offset != null) q.offset(filter.offset);
  return q;
}

export interface MemberExportRow {
  id: number;
  full_name: string;
  phone: string | null;
  sex: string | null;
  status: MemberStatus;
  joined_at: string;
  telegram_username: string | null;
  telegram_linked: boolean;
  plan_name: string | null;
  starts_at: string | null;
  expires_at: string | null;
  payments_count: number;
  total_paid: string;
  last_payment_at: string | null;
  checkins_count: number;
  last_checkin_at: string | null;
}

/** Full member data dump for the PDF export (one row per member). */
export async function exportByGym(gymId: number): Promise<MemberExportRow[]> {
  const { rows } = await db.raw(
    `
    SELECT
      m.id, m.full_name, m.phone, m.sex, m.status, m.joined_at,
      m.telegram_username,
      (m.telegram_chat_id IS NOT NULL)                             AS telegram_linked,
      p.name                                                       AS plan_name,
      s.starts_at, s.expires_at,
      COALESCE(pay.cnt, 0)::int                                    AS payments_count,
      COALESCE(pay.total, 0)::text                                 AS total_paid,
      pay.last_at                                                  AS last_payment_at,
      COALESCE(ci.cnt, 0)::int                                     AS checkins_count,
      ci.last_at                                                   AS last_checkin_at
    FROM members m
    LEFT JOIN LATERAL (
      SELECT plan_id, starts_at, expires_at FROM subscriptions
      WHERE member_id = m.id ORDER BY expires_at DESC LIMIT 1
    ) s ON TRUE
    LEFT JOIN plans p ON p.id = s.plan_id
    LEFT JOIN LATERAL (
      SELECT count(*) AS cnt, sum(amount) AS total, max(created_at) AS last_at
      FROM payments WHERE member_id = m.id
    ) pay ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*) AS cnt, max(checked_in_at) AS last_at
      FROM check_ins WHERE member_id = m.id
    ) ci ON TRUE
    WHERE m.gym_id = ? AND m.archived_at IS NULL
    ORDER BY m.full_name
  `,
    [gymId],
  );
  return rows;
}

export async function findById(gymId: number, id: number, trx: Knex = db): Promise<MemberRow | undefined> {
  return trx('members').where({ gym_id: gymId, id }).first();
}

/**
 * `joined_at` defaults to now() in the schema and is only ever passed when
 * back-filling a member who joined before the system was installed.
 */
export async function create(
  gymId: number,
  data: MemberInput & { joined_at?: string | Date },
  trx: Knex = db,
): Promise<MemberRow> {
  const [row] = await trx('members').insert({ ...data, gym_id: gymId }).returning('*');
  return row;
}

export async function update(
  gymId: number,
  id: number,
  data: Partial<MemberInput> & { joined_at?: string | Date },
  trx: Knex = db,
): Promise<MemberRow | undefined> {
  const [row] = await trx('members').where({ gym_id: gymId, id }).update(data).returning('*');
  return row;
}

export async function setStatus(id: number, status: MemberStatus, trx: Knex = db): Promise<void> {
  await trx('members').where({ id }).update({ status });
}

export async function setArchived(
  gymId: number,
  id: number,
  archived: boolean,
  trx: Knex = db,
): Promise<MemberRow | undefined> {
  const [row] = await trx('members')
    .where({ gym_id: gymId, id })
    .update({ archived_at: archived ? new Date() : null })
    .returning('*');
  return row;
}

/** How many payments reference this member — the test for "can this be deleted?". */
export async function paymentCount(memberId: number, trx: Knex = db): Promise<number> {
  const row = await trx('payments').where({ member_id: memberId }).count<{ count: string }>('id as count').first();
  return Number(row?.count ?? 0);
}

/**
 * Permanent removal. Subscriptions, face descriptors, check-ins and
 * notifications are ON DELETE CASCADE; guests.converted_member_id is not, so
 * that pointer is cleared first (the guest's own record is history and stays).
 *
 * Callers must have established that the member has no payments — the payments
 * FK would refuse anyway, but with a constraint error instead of an explanation.
 */
export async function hardDelete(gymId: number, id: number, trx: Knex = db): Promise<void> {
  await trx('guests').where({ converted_member_id: id }).update({ converted_member_id: null });
  await trx('members').where({ gym_id: gymId, id }).delete();
}

/** All descriptors for a gym's non-expired-beyond-recognition members (monitor cache). */
/**
 * Cheap change-token for `listDescriptorsByGym`, polled by the monitor in
 * place of the full payload.
 *
 * The monitor needs cross-device freshness (the office enrolls a member, the
 * tablet at the door must recognise them), which is why it polled. But the
 * full payload is ~2.6 KB per capture — a 150-member gym re-downloaded ~2 MB
 * every 60 seconds to learn nothing had changed.
 *
 * The hash covers exactly what the full response projects, so it moves if and
 * only if that response would differ: a capture added or removed (fd.id), a
 * member archived or deleted (row gone), a status flip that must change a
 * door decision, or a rename.
 */
export async function descriptorsVersion(gymId: number): Promise<string> {
  const { rows } = await db.raw(
    `SELECT coalesce(
              md5(string_agg(fd.id || ':' || m.status || ':' || m.full_name, ',' ORDER BY fd.id)),
              'empty'
            ) AS version
       FROM face_descriptors fd
       JOIN members m ON m.id = fd.member_id
      WHERE m.gym_id = ? AND m.archived_at IS NULL`,
    [gymId],
  );
  return rows[0].version as string;
}

export async function listDescriptorsByGym(gymId: number): Promise<
  { member_id: number; full_name: string; status: MemberStatus; descriptors: number[][] }[]
> {
  const rows: { member_id: number; full_name: string; status: MemberStatus; descriptor: number[] }[] =
    await db('face_descriptors as fd')
      .join('members as m', 'm.id', 'fd.member_id')
      .where('m.gym_id', gymId)
      // an archived member must not be recognised at the door
      .whereNull('m.archived_at')
      .select('fd.member_id', 'm.full_name', 'm.status', 'fd.descriptor');

  const byMember = new Map<number, { member_id: number; full_name: string; status: MemberStatus; descriptors: number[][] }>();
  for (const r of rows) {
    const entry = byMember.get(r.member_id) ?? {
      member_id: r.member_id,
      full_name: r.full_name,
      status: r.status,
      descriptors: [],
    };
    entry.descriptors.push(r.descriptor);
    byMember.set(r.member_id, entry);
  }
  return [...byMember.values()];
}

export async function addDescriptors(memberId: number, descriptors: number[][], trx: Knex = db): Promise<void> {
  await trx('face_descriptors').insert(descriptors.map((d) => ({ member_id: memberId, descriptor: d })));
}

export async function clearDescriptors(memberId: number, trx: Knex = db): Promise<void> {
  await trx('face_descriptors').where({ member_id: memberId }).delete();
}

export async function setLinkToken(gymId: number, memberId: number, token: string): Promise<void> {
  await db('members').where({ gym_id: gymId, id: memberId }).update({ telegram_link_token: token });
}

export async function findByLinkToken(token: string): Promise<MemberRow | undefined> {
  return db('members').where({ telegram_link_token: token }).first();
}

/**
 * The member behind a Telegram chat, for commands the member sends us.
 *
 * Scoped to the gym whose bot received the message: one person can be a member
 * of two gyms running two bots from the same Telegram account, and each bot
 * must answer about its own gym only. Archived members are excluded — they
 * still hold their chat id, and someone removed from the gym should not keep
 * querying it.
 */
export async function findByTelegramChatId(
  gymId: number,
  chatId: number,
): Promise<MemberRow | undefined> {
  return db('members')
    .where({ gym_id: gymId, telegram_chat_id: chatId })
    .whereNull('archived_at')
    .first();
}

export async function bindTelegram(
  memberId: number,
  chatId: number,
  username: string | null,
): Promise<void> {
  await db('members')
    .where({ id: memberId })
    .update({ telegram_chat_id: chatId, telegram_username: username, telegram_link_token: null });
}

export async function descriptorCount(memberId: number): Promise<number> {
  const row = await db('face_descriptors').where({ member_id: memberId }).count<{ count: string }>('id as count').first();
  return Number(row?.count ?? 0);
}

/**
 * Advances the absence-nudge template rotation. Called once per nudge
 * dispatched, including the ones that failed to deliver or had no chat id —
 * matching the notification-row count this replaced, so the rotation a member
 * sees does not change.
 */
export async function bumpAbsenceNudgeCount(memberId: number): Promise<void> {
  await db('members').where({ id: memberId }).increment('absence_nudge_count', 1);
}
