# Backups and usage alerting

Two GitHub Actions workflows in `.github/workflows/`:

| Workflow | Schedule | What it does |
|---|---|---|
| `db-backup.yml` | 01:00 UTC daily (04:00 Addis) | `pg_dump` → restore-verify → GPG-encrypt → 30-day artifact |
| `neon-usage-alert.yml` | 06:30 UTC daily (09:30 Addis) | Reads Neon consumption, Telegrams you past 60% of quota |

## Required repository secrets

Set under **Settings → Secrets and variables → Actions**, or with `gh`:

```bash
gh secret set DATABASE_URL               # the Neon connection string (use the -pooler host)
gh secret set BACKUP_PASSPHRASE          # invent a long random one; store it in your password manager
gh secret set NEON_API_KEY               # console.neon.tech → Account settings → API keys
gh secret set ALERT_TELEGRAM_BOT_TOKEN   # a bot from @BotFather (can be a dedicated ops bot)
gh secret set ALERT_TELEGRAM_CHAT_ID     # your own chat id — message @userinfobot to get it
gh secret set NEON_ORG_ID                # optional; only if the projects live under an org
```

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

# 2. Restore into a fresh Neon project (never over the live one first):
pg_restore --no-owner --no-privileges --clean --if-exists \
           --dbname "$THROWAWAY_DATABASE_URL" backup.dump

# One table only, if that is all you lost:
pg_restore --no-owner --table=members --data-only \
           --dbname "$THROWAWAY_DATABASE_URL" backup.dump
```

## Quota numbers

Neon Free allows **100 CU-hours per project per month**. `neon-usage-alert.yml` warns at 60%
and projects the month-end total from the run rate, so you get roughly three weeks of notice.
Both numbers are `env:` values at the top of that workflow — change them there if the plan changes.

Note that the quota is **per project**, which is why moving each gym to its own Neon project
multiplies the allowance. Only worth doing if the tuned connection pool and the
activity-gated keep-alive (`src/utils/activity.ts`) do not bring the projection under 100.
