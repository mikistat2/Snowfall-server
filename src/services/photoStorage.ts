import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env';

/**
 * Member profile photos, stored as objects instead of inline base64.
 *
 * Two drivers behind one interface (see `env.photos`): 'local' writes to disk
 * so the feature can be developed and tested with no cloud account, 'supabase'
 * writes to a public Storage bucket for real deployments. Callers never learn
 * which is in use — they hand over bytes and get back a URL.
 *
 * The Supabase driver talks to the Storage REST API over `fetch` rather than
 * pulling in @supabase/supabase-js. The whole surface used here is three
 * endpoints, and the SDK's other half (Auth, Realtime, PostgREST) is dead
 * weight in a server that reaches Postgres through Knex.
 */

/** Two renditions per member: one for lists, one for the detail page. */
export type PhotoSize = 'thumb' | 'full';

export const PHOTO_SIZES: PhotoSize[] = ['thumb', 'full'];

/**
 * One year. The path is stable, so without a cache-buster a replaced photo
 * would serve stale bytes for that whole year — `photo_version` in the query
 * string is what makes a long lifetime safe. Do not shorten this to solve a
 * staleness bug: it trades one cache miss for permanent egress.
 */
const CACHE_SECONDS = 31_536_000;

/**
 * Objects are always named .webp even when the bytes are JPEG.
 *
 * The client encodes WebP and falls back to JPEG only on WebViews too old to
 * produce it. Carrying the real extension would mean storing it, and every URL
 * builder would need the row to know what to ask for. Browsers dispatch on the
 * Content-Type header (and sniff the magic bytes regardless), so the name in
 * the path is cosmetic — the header below is what actually matters.
 */
function objectPath(key: string, size: PhotoSize): string {
  return `${key}/${size}.webp`;
}

/**
 * 128 bits of randomness, base64url. This is the ONLY thing protecting a photo
 * in a public bucket, so it must not be derived from the gym or member id —
 * those are sequential and can be walked. Long enough that guessing is not a
 * strategy.
 */
export function newPhotoKey(): string {
  return randomBytes(16).toString('base64url');
}

/** Absolute URL for one rendition, cache-busted by the member's photo_version. */
export function publicUrl(key: string, version: number, size: PhotoSize): string {
  const object = objectPath(key, size);
  const base =
    env.photos.driver === 'supabase'
      ? `${env.photos.supabase.url}/storage/v1/object/public/${env.photos.supabase.bucket}/${object}`
      : `${env.photos.apiUrl}/uploads/photos/${object}`;
  return `${base}?v=${version}`;
}

/** Absolute path on disk for the local driver, also used to serve the files. */
export function localRoot(): string {
  return path.isAbsolute(env.photos.localDir)
    ? env.photos.localDir
    : path.resolve(process.cwd(), env.photos.localDir);
}

/** True when the configured driver can actually be used. */
export function isConfigured(): boolean {
  if (env.photos.driver !== 'supabase') return true;
  return Boolean(env.photos.supabase.url && env.photos.supabase.serviceKey);
}

async function supabaseFetch(object: string, init: RequestInit): Promise<Response> {
  const { url, serviceKey, bucket } = env.photos.supabase;
  const res = await fetch(`${url}/storage/v1/object/${bucket}/${object}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      ...(init.headers ?? {}),
    },
  });
  return res;
}

/**
 * Writes both renditions for one member.
 *
 * Deliberately sequential rather than Promise.all: a partial write is the one
 * outcome that must not happen quietly, and the caller only bumps
 * `photo_version` after this resolves. If the second upload throws, the first
 * object is left behind under a key the database never learns about — an
 * orphan, which the sweep collects, rather than a member whose detail page
 * shows a broken image for a year.
 */
export async function save(
  key: string,
  images: Record<PhotoSize, Buffer>,
  contentType: string,
): Promise<void> {
  if (env.photos.driver === 'supabase') {
    for (const size of PHOTO_SIZES) {
      const res = await supabaseFetch(objectPath(key, size), {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Cache-Control': `max-age=${CACHE_SECONDS}`,
          // Replaces rather than 409s, so a re-taken photo overwrites in place
          // and the version bump is what makes it visible.
          'x-upsert': 'true',
        },
        body: new Uint8Array(images[size]),
      });
      if (!res.ok) {
        throw new Error(`photo upload failed (${size}): ${res.status} ${await res.text()}`);
      }
    }
    return;
  }

  const dir = path.join(localRoot(), key);
  await mkdir(dir, { recursive: true });
  for (const size of PHOTO_SIZES) {
    await writeFile(path.join(dir, `${size}.webp`), images[size]);
  }
}

/**
 * Deletes both renditions. Best-effort by design: this runs when a member is
 * deleted or their photo removed, and a storage error must not fail that
 * operation. What is left behind is an orphan, which is a cleanup problem, not
 * a correctness one.
 */
export async function remove(key: string): Promise<void> {
  try {
    if (env.photos.driver === 'supabase') {
      for (const size of PHOTO_SIZES) {
        await supabaseFetch(objectPath(key, size), { method: 'DELETE' });
      }
      return;
    }
    await rm(path.join(localRoot(), key), { recursive: true, force: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[photos] failed to delete ${key}:`, (err as Error).message);
  }
}
