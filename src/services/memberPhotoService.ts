import { db } from '../db/knex';
import * as memberModel from '../models/memberModel';
import * as photoStorage from '../services/photoStorage';
import type { MemberRow, PhotoSource } from '../types';
import { AppError, badRequest, notFound } from '../utils/errors';

/**
 * Member profile photos: validation, storage, and the URLs the client renders.
 *
 * The images arrive already shrunk. The browser has the original at full
 * resolution and a canvas to resize it with, so uploading a 12 MP camera frame
 * for the server to shrink would spend bandwidth on both legs to reach the same
 * 25 KB. The ceilings below are therefore a sanity check on a client that has
 * already done the work, not a resizing step — this server has no image
 * library and deliberately does not want one.
 */

/** Generous ceilings. The client aims at ~5 KB and ~25 KB; these catch bugs. */
const MAX_BYTES: Record<photoStorage.PhotoSize, number> = {
  thumb: 40 * 1024,
  full: 200 * 1024,
};

/**
 * WebP is what the client encodes. JPEG is the fallback for WebViews too old
 * to produce WebP, and PNG is what some of those return instead of failing
 * cleanly — accepted so an old device can still enroll, and caught by the size
 * ceiling if it is unreasonably large.
 */
const ALLOWED_TYPES = ['image/webp', 'image/jpeg', 'image/png'];

const DATA_URL = /^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)$/;

interface Decoded {
  buffer: Buffer;
  contentType: string;
}

function decode(dataUrl: string, size: photoStorage.PhotoSize): Decoded {
  const match = DATA_URL.exec(dataUrl.trim());
  if (!match) throw badRequest(`${size} image is not a base64 image data URL`);

  const [, contentType, base64] = match as unknown as [string, string, string];
  if (!ALLOWED_TYPES.includes(contentType)) {
    throw badRequest(`${size} image type ${contentType} is not allowed`);
  }

  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0) throw badRequest(`${size} image is empty`);
  if (buffer.length > MAX_BYTES[size]) {
    throw new AppError(
      413,
      `${size} image is ${Math.round(buffer.length / 1024)} KB, over the ${MAX_BYTES[size] / 1024} KB limit`,
    );
  }
  return { buffer, contentType };
}

/**
 * The URLs a client needs to render a member's picture, or nulls when there is
 * none.
 *
 * Both renditions are returned on every member — they are short strings, and
 * which ones actually get fetched is the client's decision (the roster renders
 * a thumbnail only for members who are expiring or expired; the detail page
 * always renders the full one). Returning the strings costs nothing; the bytes
 * are where the egress is.
 *
 * A gym enrolled before object storage has its picture in the legacy
 * `photo_url` column as inline base64. Pass it in and it is used as a fallback,
 * so those members keep a face until the backfill moves them across.
 *
 * The roster query deliberately does NOT read that column, so list rows have no
 * `photo_url` and legacy members show their initials there rather than putting
 * half a megabyte of base64 back into the response this change exists to
 * shrink. The detail page, which loads one member, passes it and shows it.
 */
export function photoUrls(member: {
  photo_key: string | null;
  photo_version: number;
  photo_url?: string | null;
}): {
  photo_thumb_url: string | null;
  photo_full_url: string | null;
} {
  if (member.photo_key) {
    return {
      photo_thumb_url: photoStorage.publicUrl(member.photo_key, member.photo_version, 'thumb'),
      photo_full_url: photoStorage.publicUrl(member.photo_key, member.photo_version, 'full'),
    };
  }
  const legacy = member.photo_url ?? null;
  return { photo_thumb_url: legacy, photo_full_url: legacy };
}

/**
 * Stores a new picture for one member and returns its URLs.
 *
 * `source` is what stops enrollment from undoing deliberate work. A photo
 * grabbed off the door camera is a badly-lit frame of whoever happened to be
 * standing there; one a staff member took or picked is chosen. So 'auto' will
 * not overwrite a picture that a human set — it simply does nothing and
 * reports the existing one. A human can always overwrite anything.
 */
export async function setPhoto(
  gymId: number,
  memberId: number,
  images: { thumb: string; full: string },
  source: PhotoSource,
): Promise<{ photo_thumb_url: string | null; photo_full_url: string | null }> {
  if (!photoStorage.isConfigured()) {
    throw new AppError(503, 'Photo storage is not configured on this server');
  }

  const member = await memberModel.findById(gymId, memberId);
  if (!member) throw notFound('Member not found');

  if (source === 'auto' && member.photo_source === 'manual') {
    return photoUrls(member);
  }

  const thumb = decode(images.thumb, 'thumb');
  const full = decode(images.full, 'full');
  if (thumb.contentType !== full.contentType) {
    throw badRequest('Both images must be the same format');
  }

  // Reuse the key on replacement so the old objects are overwritten rather
  // than orphaned; the version bump is what makes the new bytes visible past
  // the year-long cache.
  const key = member.photo_key ?? photoStorage.newPhotoKey();
  await photoStorage.save(key, { thumb: thumb.buffer, full: full.buffer }, thumb.contentType);

  // Written only after the upload resolved. A row pointing at objects that do
  // not exist would render a broken image until someone re-took the photo.
  const [updated] = await db('members')
    .where({ gym_id: gymId, id: memberId })
    .update({
      photo_key: key,
      photo_version: member.photo_version + 1,
      photo_source: source,
      // The legacy inline copy is dead weight once a stored object exists, and
      // it is the larger of the two. Clearing it here is what actually removes
      // the base64 from the member-list payload.
      photo_url: null,
      updated_at: db.fn.now(),
    })
    .returning<MemberRow[]>('*');

  return photoUrls(updated!);
}

/** Removes a member's picture. Safe to call when they never had one. */
export async function clearPhoto(gymId: number, memberId: number): Promise<void> {
  const member = await memberModel.findById(gymId, memberId);
  if (!member) throw notFound('Member not found');

  await db('members').where({ gym_id: gymId, id: memberId }).update({
    photo_key: null,
    photo_version: 0,
    photo_source: null,
    photo_url: null,
    updated_at: db.fn.now(),
  });

  // After the row, and best-effort: an object with nothing pointing at it is
  // an orphan, while a row pointing at a deleted object is a broken image.
  if (member.photo_key) await photoStorage.remove(member.photo_key);
}
