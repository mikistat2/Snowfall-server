# Backups and usage alerting

Two GitHub Actions workflows in `.github/workflows/`:

| Workflow | Schedule | What it does |
|---|---|---|
| `db-backup.yml` | 01:00 UTC daily (04:00 Addis) | `pg_dump` → restore-verify → GPG-encrypt → 30-day artifact |
| `db-size-alert.yml` | 06:30 UTC daily (09:30 Addis) | Measures database size, Telegrams you past 60% of the storage quota |

## Required repository secrets

Set under **Settings → Secrets and variables → Actions**, or with `gh`:

```bash
gh secret set DATABASE_URL               # the Supabase connection string (use the POOLER host)
gh secret set BACKUP_PASSPHRASE          # invent a long random one; store it in your password manager
gh secret set ALERT_TELEGRAM_BOT_TOKEN   # a bot from @BotFather (can be a dedicated ops bot)
gh secret set ALERT_TELEGRAM_CHAT_ID     # your own chat id — message @userinfobot to get it
```

`NEON_API_KEY` and `NEON_ORG_ID` are no longer used and can be deleted. The old
alert had to ask Neon's API how many compute-hours had been burned; Supabase
bills storage instead, and the database can be asked its own size — so the
replacement needs no provider API key and survives the next host change.

**If you lose `BACKUP_PASSPHRASE`, every backup is unreadable.** There is no recovery path —
that is the point of symmetric encryption. Put it somewhere that is not this repository.

## Why the dump is encrypted

`mikistat2/Snowfall-server` is a **public** repository, and Actions artifacts on a public
repository can be downloaded by anyone who can read the repo. The dump contains member names,
phone numbers, payment history and face descriptors. GPG means the artifact is inert without
the passphrase.

This is a mitigation, not a fix. Two things still want doing:

1. Make the repository **private**.
2. `.env` and `.env.bak-port` are committed here and hold `JWT_ACCESS_SECRET`,
   `JWT_REFRESH_SECRET`, `PLATFORM_ADMIN_PASSWORD`, `DB_PASSWORD` and `SMTP_PASS`. Those have
   been public. Rotate them and remove the files from the repo.

## The backup verifies itself

An untested backup is a guess, so `db-backup.yml` does not trust its own dump. Every night it:

1. rejects a dump under 20 KB,
2. restores it into a throwaway `postgres:17` service container,
3. asserts the restore produced ≥ 10 tables and ≥ 1 member.

A dump that fails any of those fails the run and pings Telegram, instead of sitting in the
artifact list looking like a backup.

## Restoring for real

```bash
# 1. Download the artifact from the run page, then:
gpg --batch --decrypt --passphrase 'YOUR_PASSPHRASE' \
    --output backup.dump backup-2026-08-21.dump.gpg

# 2. Restore into a fresh Supabase project (never over the live one first):
pg_restore --no-owner --no-privileges --clean --if-exists \
           --dbname "$THROWAWAY_DATABASE_URL" backup.dump

# One table only, if that is all you lost:
pg_restore --no-owner --table=members --data-only \
           --dbname "$THROWAWAY_DATABASE_URL" backup.dump
```

## Quota numbers

Supabase Free allows **500 MB of database storage** per project. `db-size-alert.yml` warns at
60%, and names the five largest tables so you can see what grew. Both numbers are `env:` values
at the top of that workflow — change them there if the plan changes.

The two append-only log tables (`events`, `audit_logs`) are the usual cause of growth and are
pruned on a retention window in `src/jobs/index.ts` (90 and 365 days). If the alert fires, check
those first.

Free-plan projects are also **paused after 7 consecutive days with no activity**, and unpausing
is a manual click in the dashboard. A gym in daily use never gets near it; a demo project left
alone over a holiday will.

## Moving the database again

Two tools, and which one you need depends entirely on the Postgres versions.

### Same major version, or moving to a NEWER one

```bash
./scripts/migrate-db.sh "<source-url>" "<target-url>"
```

Full `pg_dump` → `pg_restore` → verify. It refuses to report success unless every table's
exact row count matches, and refuses to restore over a non-empty target.

### Moving to an OLDER major version

This is what the Neon → Supabase move actually was: **Neon ran Postgres 18, Supabase runs 17.**
`pg_dump` is useless there — it refuses to read a server newer than itself, and a dump taken
from a newer major is not guaranteed to replay onto an older one. So the schema is rebuilt by
the migrations (making it native to the target's own version) and only the rows are copied:

```bash
# 1. Build the schema ON THE TARGET from the compiled migrations, so
#    knex_migrations records the ".js" names Render's AUTO_MIGRATE expects.
#    (Running the .ts migrations records ".ts" names, and Render would then
#    try to re-run all of them on its next boot.)
npm run build
cat > .runner.js <<'JS'
const path = require('path'), knex = require('knex');
const db = knex({ client: 'pg', connection: { connectionString: process.env.TARGET_URL, ssl: { rejectUnauthorized: false } } });
db.migrate.latest({ directory: path.resolve('dist/db/migrations'), loadExtensions: ['.js'], tableName: 'knex_migrations' })
  .then(([b, m]) => { console.log(b, m); return db.destroy(); })
  .catch((e) => { console.error(e); process.exit(1); });
JS
TARGET_URL="<target-url>" node .runner.js && rm .runner.js

# 2. Clear the rows the migrations insert themselves (billing_plans,
#    billing_settings, platform_settings) — the source's copies are the real ones.
psql "<target-url>" -c 'TRUNCATE <tables> RESTART IDENTITY CASCADE;'

# 3. Copy every table in FK-safe order, verifying counts per table.
./scripts/copy-data.sh "<source-url>" "<target-url>"
```

`copy-data.sh` resets every sequence afterwards. Do not skip that: `COPY` writes explicit ids
without advancing the sequence behind the column, so a migration that looks perfect fails on
the first row anyone inserts.

### Verifying the move

Row counts are not proof. Fingerprint the contents on both sides:

```sql
SET TimeZone TO 'UTC';
SET extra_float_digits = 1;   -- see the note below; without this, floats differ cosmetically
SELECT table_name, md5(...)   -- hash every row's text form, ordered
```

Two differences are expected and are **not** data loss:

- **Postgres 18 lists NOT NULL constraints in `pg_constraint` (`contype='n'`); 17 does not.**
  A schema diff will show one row per NOT NULL column. Compare `information_schema.columns`
  instead — that agrees.
- **Supabase's pooler sets `extra_float_digits = 0`, Postgres' default is 1.** A `real`
  then prints six significant digits rather than the shortest round-tripping form, so
  `0.24337596` reads back as `0.243376`. The stored bits are identical — compare
  `encode(float4send(col),'hex')` to prove it. `config/database.ts` pins the setting back to 1
  on every connection so the app is unaffected.

`scripts/supabase-harden.sql` is the Supabase-specific follow-up (see below).

## Supabase-specific: the Data API

Supabase serves the `public` schema over HTTPS via PostgREST to anyone with the project's anon
key. This app does not use it — everything goes through Knex — so it is an open door with no
upside. Two locks, apply both:

1. `psql "$DATABASE_URL" -f scripts/supabase-harden.sql` — enables RLS on every public table.
   With no policies attached, PostgREST returns nothing. The app is unaffected: it connects as
   the tables' owner, and an owner bypasses RLS.
2. Dashboard → Settings → API → **Exposed schemas**: remove `public`.
