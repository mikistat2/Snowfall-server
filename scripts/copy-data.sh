#!/usr/bin/env bash
#
# Copy table data between two Postgres databases that pg_dump cannot bridge.
#
#   ./scripts/copy-data.sh "<SOURCE_URL>" "<TARGET_URL>"
#
# Use this instead of scripts/migrate-db.sh when the TARGET is an OLDER major
# version than the SOURCE (as in the Neon 18 -> Supabase 17 move): pg_dump
# refuses to read a server newer than itself, and a dump taken from a newer
# major is not guaranteed to replay onto an older one. COPY has no such
# problem — it moves rows, not DDL.
#
# The target must ALREADY HAVE THE SCHEMA, built by the migrations themselves:
#
#   npm run build
#   TARGET_URL="<target>" node -e "..."   # see BACKUPS.md
#
# so the schema is native to the target's own major version.
#
# Columns are listed explicitly and sorted by name on BOTH sides, so a
# difference in physical column order between the two databases cannot silently
# shift values into the wrong columns.
set -euo pipefail

SRC="${1:?usage: copy-data.sh <source-url> <target-url>}"
DST="${2:?usage: copy-data.sh <source-url> <target-url>}"
HERE="$(cd "$(dirname "$0")" && pwd)"

# Some poolers (Neon's, notably) hand out an empty search_path, which makes
# every unqualified table name fail. Never rely on it.
PSQL_SRC=(psql "$SRC" -X -v ON_ERROR_STOP=1)
PSQL_DST=(psql "$DST" -X -v ON_ERROR_STOP=1)

echo "==> computing FK-safe load order from the source"
mapfile -t TABLES < <("${PSQL_SRC[@]}" -tA -f "$HERE/topo-order.sql" | sed 's/[[:space:]]*$//' | grep -v '^$')
if [ "${#TABLES[@]}" -eq 0 ]; then
  echo "!! source reported no tables — refusing to continue" >&2
  exit 1
fi
echo "    ${#TABLES[@]} tables: ${TABLES[*]}"

echo "==> checking the target is empty"
for t in "${TABLES[@]}"; do
  n=$("${PSQL_DST[@]}" -tA -c "SELECT count(*) FROM public.$t;")
  if [ "$n" -ne 0 ]; then
    echo "!! target public.$t already holds $n rows." >&2
    echo "   Re-running a copy over existing data would duplicate it. Clear first:" >&2
    echo "     psql \"\$TARGET\" -c 'TRUNCATE $(IFS=,; echo "${TABLES[*]}") RESTART IDENTITY CASCADE;'" >&2
    exit 1
  fi
done

echo "==> copying"
for t in "${TABLES[@]}"; do
  cols=$("${PSQL_SRC[@]}" -tA -c "
    SELECT string_agg(quote_ident(column_name), ',' ORDER BY column_name)
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='$t';")

  "${PSQL_SRC[@]}" -c "\copy (SELECT $cols FROM public.$t) TO STDOUT WITH (FORMAT csv)" \
    | "${PSQL_DST[@]}" -c "\copy public.$t ($cols) FROM STDIN WITH (FORMAT csv)"
  # A pipe's exit status is the LAST command's, so a failed dump on the left
  # would otherwise pass unnoticed as an empty-but-successful load.
  st=("${PIPESTATUS[@]}")
  if [ "${st[0]}" -ne 0 ] || [ "${st[1]}" -ne 0 ]; then
    echo "!! copy of $t failed (source=${st[0]} target=${st[1]})" >&2
    exit 1
  fi

  s=$("${PSQL_SRC[@]}" -tA -c "SELECT count(*) FROM public.$t;")
  d=$("${PSQL_DST[@]}" -tA -c "SELECT count(*) FROM public.$t;")
  if [ "$s" -ne "$d" ]; then
    echo "!! $t: source has $s rows, target has $d" >&2
    exit 1
  fi
  printf '    %-20s %6s rows\n' "$t" "$d"
done

# COPY writes explicit id values without touching the sequence behind the
# column, so every sequence is still sitting at 1. The next INSERT would then
# collide with an existing primary key. This is the single most common way a
# COPY-based migration looks perfect and breaks on the first write.
echo "==> resetting sequences to follow the copied ids"
"${PSQL_DST[@]}" -tA -c "
  SELECT format('SELECT setval(%L, COALESCE((SELECT max(%I) FROM public.%I), 0) + 1, false);',
                pg_get_serial_sequence('public.'||table_name, column_name), column_name, table_name)
  FROM information_schema.columns
  WHERE table_schema='public' AND column_default LIKE 'nextval%'
    AND table_name NOT LIKE 'knex_migrations%';" \
  | "${PSQL_DST[@]}" -f - > /dev/null
echo "    done"

echo
echo "==> all tables copied and row counts match"
