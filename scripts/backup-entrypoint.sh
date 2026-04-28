#!/bin/sh
# Sprino — backup sidecar entrypoint.
#
# Sets up a busybox crontab that invokes /usr/local/bin/backup.sh on the
# schedule defined by BACKUP_CRON (default "0 2 * * *", i.e. 02:00 every
# day in the container's TZ) and starts crond in the foreground.
#
# Logs are streamed to stdout/stderr so `docker compose logs` shows backup
# activity. A run-on-start hook (BACKUP_RUN_ON_START=1) is supported for
# tests / smoke checks; off by default to avoid surprising operators when
# the sidecar restarts.

set -eu

CRON_EXPR="${BACKUP_CRON:-0 2 * * *}"
CRON_FILE="/var/spool/cron/crontabs/root"

# Cron's env-line format is single-line KEY=value. Any newline or carriage
# return in a passed-through env var would break out of its line and could
# inject extra crontab entries. Reject such values up front rather than
# silently producing a malformed (or hostile) crontab.
require_single_line() {
  var_name=$1
  var_value=$2
  case $var_value in
    *"$(printf '\n')"*|*"$(printf '\r')"*)
      echo "[backup-sidecar] invalid $var_name: must not contain newlines or carriage returns" >&2
      exit 1
      ;;
  esac
}

pg_host="${PGHOST:-}"
pg_port="${PGPORT:-}"
pg_user="${PGUSER:-}"
pg_password="${PGPASSWORD:-}"
pg_database="${PGDATABASE:-}"
backup_dir="${BACKUP_DIR:-/backups}"
backup_retention="${BACKUP_RETENTION:-30}"
backup_prefix="${BACKUP_PREFIX:-sprino-}"

require_single_line "PGHOST" "$pg_host"
require_single_line "PGPORT" "$pg_port"
require_single_line "PGUSER" "$pg_user"
require_single_line "PGPASSWORD" "$pg_password"
require_single_line "PGDATABASE" "$pg_database"
require_single_line "BACKUP_DIR" "$backup_dir"
require_single_line "BACKUP_RETENTION" "$backup_retention"
require_single_line "BACKUP_PREFIX" "$backup_prefix"
require_single_line "BACKUP_CRON" "$CRON_EXPR"

mkdir -p "$(dirname "$CRON_FILE")"

# Pass through the runtime env to cron jobs (cron strips most env vars).
{
  printf '%s\n' "PGHOST=$pg_host"
  printf '%s\n' "PGPORT=$pg_port"
  printf '%s\n' "PGUSER=$pg_user"
  printf '%s\n' "PGPASSWORD=$pg_password"
  printf '%s\n' "PGDATABASE=$pg_database"
  printf '%s\n' "BACKUP_DIR=$backup_dir"
  printf '%s\n' "BACKUP_RETENTION=$backup_retention"
  printf '%s\n' "BACKUP_PREFIX=$backup_prefix"
  printf '%s\n' "$CRON_EXPR /usr/local/bin/backup.sh >> /proc/1/fd/1 2>> /proc/1/fd/2"
} > "$CRON_FILE"
chmod 600 "$CRON_FILE"

echo "[backup-sidecar] cron schedule: $CRON_EXPR"
echo "[backup-sidecar] backup dir:    $backup_dir"
echo "[backup-sidecar] retention:     $backup_retention"
echo "[backup-sidecar] prefix:        $backup_prefix"

if [ "${BACKUP_RUN_ON_START:-0}" = "1" ]; then
  echo "[backup-sidecar] BACKUP_RUN_ON_START=1 — running an initial backup now"
  /usr/local/bin/backup.sh || echo "[backup-sidecar] initial backup failed (continuing to schedule)"
fi

# -f: foreground; -L /dev/stderr: log to stderr instead of syslog.
exec crond -f -L /dev/stderr
