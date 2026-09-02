import type { Knex } from 'knex';

/**
 * Member profile photos as stored objects rather than inline base64.
 *
 * `photo_url` (the original column) holds a base64 data URL written at
 * enrollment from the first face capture. That works, but the bytes travel in
 * every row of every member-list response, and they sit inside the 500 MB
 * database quota. These columns move the image out to object storage and leave
 * the row carrying only enough to build a URL.
 *
 * The old column is deliberately NOT dropped here. Existing gyms have photos in
 * it, and a backfill that moves them into storage has to run against a live
 * deployment before the column can go. Until then both are read, newest wins.
 *
 * photo_key
 *   Random, unguessable path segment — NOT the gym or member id. The bucket is
 *   public so that the CDN can cache it (a signed URL changes on every request
 *   and defeats caching entirely), which means the path is the only thing
 *   standing between a stranger and a member's face. `gym7/member312` can be
 *   counted through; this cannot.
 *
 * photo_version
 *   Bumped on every successful replacement. Objects are written with a
 *   one-year cache lifetime, so a re-taken photo would otherwise keep serving
 *   the old bytes for a year. The URL carries ?v=<version>, which misses the
 *   cache exactly once and then caches again. Shortening the cache lifetime
 *   would trade that single miss for permanent egress.
 *
 * photo_source
 *   'manual' — a human chose this picture.
 *   'auto'   — grabbed from the face-capture frame at enrollment.
 *   Enrollment auto-grabs a doorway webcam frame; a staff member taking a
 *   deliberate portrait produces a better one. This column is what lets the
 *   upload path refuse to let 'auto' overwrite 'manual'.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE members
      ADD COLUMN photo_key     TEXT,
      ADD COLUMN photo_version INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN photo_source  TEXT
        CHECK (photo_source IS NULL OR photo_source IN ('manual', 'auto'));
  `);

  // Unique across all gyms, not per gym: the key IS the whole path, so a
  // collision would let one gym's upload land on another gym's photo.
  await knex.raw(`
    CREATE UNIQUE INDEX members_photo_key_unique ON members (photo_key)
      WHERE photo_key IS NOT NULL;
  `);

  // A key with no version, or a version with no key, means the two writes that
  // must happen together did not. Cheaper to reject here than to serve a
  // broken image for a year.
  await knex.raw(`
    ALTER TABLE members
      ADD CONSTRAINT members_photo_key_versioned
      CHECK (photo_key IS NULL OR photo_version > 0);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE members DROP CONSTRAINT IF EXISTS members_photo_key_versioned;`);
  await knex.raw(`DROP INDEX IF EXISTS members_photo_key_unique;`);
  await knex.raw(`
    ALTER TABLE members
      DROP COLUMN IF EXISTS photo_key,
      DROP COLUMN IF EXISTS photo_version,
      DROP COLUMN IF EXISTS photo_source;
  `);
}
