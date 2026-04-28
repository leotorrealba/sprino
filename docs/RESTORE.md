# Restoring Sprino from a backup

When Sprino's backup sidecar (`scripts/backup.sh`, scheduled by Docker
Compose) is enabled — via either the `backup` or `full` profile (see
`docker-compose.yml`) — it writes a gzipped `pg_dump` of the application
database to `./backups/` on the host every night. This document is the
playbook for using one of those files to recover the database.

If you've been running plain `docker compose up -d` (no profile), the
sidecar has not been running and there are no backups to restore from —
that's by design for local dev, not a bug.

> **Audience.** A non-technical operator who can run shell commands in the
> Sprino directory. If you can `cd` and `docker compose up`, you can do this.

## What's in a backup

Each file is named `sprino-YYYYMMDD-HHMMSS.sql.gz` (UTC timestamp). It is a
plain-text SQL dump produced by `pg_dump --no-owner --no-privileges`,
compressed with gzip. You can read its contents with:

```sh
gunzip -c ./backups/sprino-20260101-020000.sql.gz | head -40
```

## Before you restore

Restoring **replaces** the entire `sprino_dev` database with the contents
of the backup file. Anything that was added after the backup timestamp
will be lost. **Do not skip the verification step at the end.**

## Step 1 — Stop the backend

The backend holds active connections that prevent a clean restore. Stop
the server (and web) containers, but keep Postgres running:

```sh
docker compose stop server web
```

If you're running the dev profile (Postgres-only, server on the host),
stop the host process instead:

```sh
# whichever is running, e.g.
pkill -f "bun --filter @sprino/server dev"
```

## Step 2 — Pick the backup file

```sh
ls -lt ./backups/sprino-*.sql.gz | head
```

The newest file is at the top. Pick the one you want — usually the most
recent, unless you are recovering from a known-bad event in which case
pick the last good one before that event.

```sh
BACKUP=./backups/sprino-20260101-020000.sql.gz   # adjust to your file
```

## Step 3 — Verify the file is valid

```sh
gzip -t "$BACKUP" && echo "OK: archive integrity good"
```

If this prints `gzip: ...: invalid compressed data`, the file is corrupt
— pick an earlier backup.

## Step 4 — Drop and recreate the database

This is the destructive step. It removes the current database and
creates an empty one ready for the restore. Run it inside the running
Postgres container:

```sh
docker compose exec postgres psql -U sprino -d postgres -c \
  "DROP DATABASE IF EXISTS sprino_dev;"
docker compose exec postgres psql -U sprino -d postgres -c \
  "CREATE DATABASE sprino_dev OWNER sprino;"
```

> If `DROP DATABASE` fails with "database is being accessed by other users",
> you forgot to stop the backend in Step 1. Stop it, retry.

## Step 5 — Restore the dump

```sh
gunzip -c "$BACKUP" | docker compose exec -T postgres \
  psql -U sprino -d sprino_dev
```

The `-T` flag is important — without it, `docker compose exec` allocates
a TTY which corrupts piped binary input. Expect to see a stream of
`SET`, `CREATE`, `ALTER`, `COPY`, `INSERT` lines. There may be a few
notices about extensions or owners; those are normal and harmless given
the `--no-owner --no-privileges` flags used at dump time.

## Step 6 — Start the backend

```sh
docker compose up -d server web
```

(Or restart the host server process, depending on profile.)

## Step 7 — Verify

Check that data you expect to see is actually there. The fastest sanity
check is the Sprino web UI on http://localhost:3000 — your tasks should
show up. From the shell:

```sh
docker compose exec postgres psql -U sprino -d sprino_dev -c \
  "SELECT count(*) AS tasks FROM tasks; SELECT count(*) AS events FROM events;"
```

Numbers should match what you remember from before the restore.

## Frequently encountered errors

| Error | Cause | Fix |
| --- | --- | --- |
| `database is being accessed by other users` | Backend wasn't stopped | Step 1 |
| `gzip: ...: invalid compressed data` | Corrupt backup file | Use an earlier file |
| `permission denied for schema public` | Restored as a non-owner | The backup script uses `--no-owner --no-privileges` to avoid this; if you have a legacy dump, run the restore as the `sprino` user |
| `the input device is not a TTY` (on the gunzip pipe) | Forgot `-T` on `docker compose exec` | Add `-T` |

## Testing your backups

A backup you've never restored is a backup you don't have. We recommend
walking through this playbook against a throwaway database **at least
once a quarter**:

```sh
# Spin up a scratch DB locally, restore into it, count rows, throw it away.
docker run --rm -d --name sprino-restore-test -p 5434:5432 \
  -e POSTGRES_USER=sprino -e POSTGRES_PASSWORD=sprino \
  -e POSTGRES_DB=sprino_dev postgres:16-alpine
sleep 5
gunzip -c "$BACKUP" | docker exec -i sprino-restore-test \
  psql -U sprino -d sprino_dev
docker exec sprino-restore-test psql -U sprino -d sprino_dev -c \
  "SELECT count(*) FROM tasks;"
docker stop sprino-restore-test
```

If row counts look right, your backup chain is healthy.
