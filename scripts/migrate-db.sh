#!/usr/bin/env bash
#
# One-shot Postgres move: dump the source, restore into the target, then prove
# the two agree row for row.
#
#   ./scripts/migrate-db.sh "<SOURCE_URL>" "<TARGET_URL>"
#
# The target is expected to be EMPTY (a fresh Supabase project). Restoring over
# a populated database is not what this script is for — it does not --clean, so
# it would half-merge two datasets.
#
# Requires pg_dump/pg_restore/psql at least as new as the SOURCE server's major
# version. On Windows they live in C:\Program Files\PostgreSQL\<major>\bin.
set -euo pipefail

SRC="${1:?usage: migrate-db.sh <source-url> <target-url>}"
DST="${2:?usage: migrate-db.sh <source-url> <target-url>}"
OUT="${OUT_DIR:-./.migration}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
DUMP="$OUT/source-$STAMP.dump"

mkdir -p "$OUT"

# Never print a connection string: they carry the password.
redact() { sed -E 's#(://[^:]+:)[^@]+@#\1****@#g'; }

echo "==> versions"
SRC_V=$(psql "$SRC" -tAX -c 'SHOW server_version;')
DST_V=$(psql "$DST" -tAX -c 'SHOW server_version;')
DUMP_V=$(pg_dump --version | grep -oE '[0-9]+' | head -1)
echo "    source server : $SRC_V"
echo "    target server : $DST_V"
echo "    pg_dump       : $DUMP_V"

# A dump is forward-compatible, never backward: pg_dump must be >= the server
# it reads. And a pg_dump 17 archive replayed onto a pre-17 server emits
# `SET transaction_timeout`, which that server rejects — non-fatal, but it is
# the difference between a clean log and one you have to read carefully.
if [ "${SRC_V%%.*}" -gt "$DUMP_V" ]; then
  echo "!! pg_dump ($DUMP_V) is older than the source server (${SRC_V%%.*}) — dump would be incomplete." >&2
  exit 1
fi
if [ "${DST_V%%.*}" -lt "${SRC_V%%.*}" ]; then
  echo "!! target (${DST_V%%.*}) is an OLDER major than the source (${SRC_V%%.*})."
  echo "   Downgrade restores are not supported. Recreate the target on ${SRC_V%%.*}."
  exit 1
fi

echo "==> refusing to restore over a non-empty target"
EXISTING=$(psql "$DST" -tAX -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';")
if [ "$EXISTING" -ne 0 ]; then
  echo "!! target already has $EXISTING tables in public. Use a fresh project, or drop them first:" >&2
  echo "     psql \"\$TARGET\" -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'" >&2
  exit 1
fi

echo "==> dumping source"
# Custom format: compressed, and pg_restore can go selective (one table back)
# instead of all-or-nothing like a plain SQL file.
pg_dump --format=custom --no-owner --no-privileges --file="$DUMP" "$SRC"
BYTES=$(stat -c%s "$DUMP" 2>/dev/null || stat -f%z "$DUMP")
echo "    wrote $DUMP ($BYTES bytes)"
if [ "$BYTES" -lt 20480 ]; then
  echo "!! dump is only $BYTES bytes — that is not a real database. Stopping." >&2
  exit 1
fi

echo "==> restoring into target"
# pg_restore returns non-zero on any error, including harmless ones (a role
# that does not exist on the target, a COMMENT on an extension we do not own).
# Capture the log and judge it below rather than letting `set -e` decide.
if pg_restore --no-owner --no-privileges --dbname "$DST" "$DUMP" 2> "$OUT/restore-$STAMP.log"; then
  echo "    restore completed with no errors"
else
  echo "    restore reported errors — reviewing:"
  grep -c 'error:' "$OUT/restore-$STAMP.log" | sed 's/^/    error lines: /'
  sed -n '1,40p' "$OUT/restore-$STAMP.log" | redact | sed 's/^/    | /'
  echo "    (full log: $OUT/restore-$STAMP.log)"
fi

echo "==> comparing row counts"
psql "$SRC" -tAF'|' -X -f scripts/db-rowcounts.sql | sort > "$OUT/counts-source.txt"
psql "$DST" -tAF'|' -X -f scripts/db-rowcounts.sql | sort > "$OUT/counts-target.txt"

if diff -u "$OUT/counts-source.txt" "$OUT/counts-target.txt" > "$OUT/counts-diff.txt"; then
  echo "    IDENTICAL — every table matches row for row:"
  sed 's/^/    /' "$OUT/counts-target.txt"
  echo
  echo "==> migration verified"
else
  echo "!! ROW COUNTS DIFFER (-source +target):" >&2
  sed 's/^/    /' "$OUT/counts-diff.txt" >&2
  echo >&2
  echo "   Do NOT cut over. Investigate before pointing anything at the target." >&2
  exit 1
fi

echo
echo "Next: sequences are carried by the dump, but confirm anyway —"
echo "  psql \"\$TARGET\" -c \"SELECT last_value FROM members_id_seq;\""
