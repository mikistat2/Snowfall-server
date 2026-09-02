/**
 * Proves the photo bucket is set up correctly, before a deploy depends on it.
 *
 *   PHOTO_STORAGE=supabase SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
 *     npx tsx scripts/check-photo-storage.ts
 *
 * (or just `npx tsx scripts/check-photo-storage.ts` once those are in .env)
 *
 * Writes a real object under a throwaway key, reads it back over the PUBLIC
 * URL exactly as a browser would, checks the cache header that makes this
 * affordable, then deletes it. Nothing is left behind and no member row is
 * touched.
 *
 * Every check here is one that fails silently in production if it is wrong:
 * a private bucket returns 400 on a URL the app has already handed to a
 * browser, and a missing cache header turns every avatar into a fresh download
 * on every page load — neither of which shows up as an error anywhere.
 */
import { env } from '../src/config/env';
import * as photoStorage from '../src/services/photoStorage';

/** A 1x1 WebP. Real bytes, so the bucket's MIME filter is actually exercised. */
const PIXEL = Buffer.from(
  'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==',
  'base64',
);

function ok(label: string, pass: boolean, detail = ''): boolean {
  // eslint-disable-next-line no-console
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  return pass;
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`driver: ${env.photos.driver}`);
  if (env.photos.driver !== 'supabase') {
    // eslint-disable-next-line no-console
    console.log('Set PHOTO_STORAGE=supabase to check the bucket. Nothing to do.');
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`project: ${env.photos.supabase.url}`);
  // eslint-disable-next-line no-console
  console.log(`bucket:  ${env.photos.supabase.bucket}\n`);

  const results: boolean[] = [];
  results.push(
    ok('credentials present', photoStorage.isConfigured(), 'SUPABASE_URL + SUPABASE_SERVICE_KEY'),
  );
  if (!photoStorage.isConfigured()) process.exit(1);

  const key = `_healthcheck_${Date.now()}`;
  let uploaded = false;

  try {
    await photoStorage.save(key, { thumb: PIXEL, full: PIXEL }, 'image/webp');
    uploaded = true;
    results.push(ok('upload (service key can write)', true));

    // Fetched with no credentials at all — this is what a browser does, and
    // the single most common misconfiguration is a bucket left private.
    const url = photoStorage.publicUrl(key, 1, 'thumb');
    const res = await fetch(url);
    results.push(
      ok('public read (bucket is Public)', res.ok, res.ok ? url : `${res.status} ${res.statusText}`),
    );

    const cache = res.headers.get('cache-control') ?? '';
    const seconds = Number(/max-age=(\d+)/.exec(cache)?.[1] ?? 0);
    results.push(
      ok(
        'long cache lifetime',
        seconds >= 2_592_000,
        cache || 'no cache-control header — every avatar would re-download',
      ),
    );

    const type = res.headers.get('content-type') ?? '';
    results.push(ok('content-type preserved', type.startsWith('image/'), type || 'missing'));
  } catch (err) {
    results.push(ok('upload (service key can write)', false, (err as Error).message));
  } finally {
    if (uploaded) {
      await photoStorage.remove(key);
      const gone = await fetch(photoStorage.publicUrl(key, 1, 'thumb'));
      results.push(ok('delete (test object cleaned up)', !gone.ok, `read back ${gone.status}`));
    }
  }

  const failed = results.filter((r) => !r).length;
  // eslint-disable-next-line no-console
  console.log(`\n${failed === 0 ? 'All checks passed — safe to deploy.' : `${failed} check(s) failed.`}`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
