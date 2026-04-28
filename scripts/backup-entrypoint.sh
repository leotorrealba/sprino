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

mkdir -p "$(dirname "$CRON_FILE")"

# Pass through the runtime env to cron jobs (cron strips most env vars).
{
  echo "PGHOST=${PGHOST:-}"
  echo "PGPORT=${PGPORT:-}"
  echo "PGUSER=${PGUSER:-}"
  echo "PGPASSWORD=${PGPASSWORD:-}"
  echo "PGDATABASE=${PGDATABASE:-}"
  echo "BACKUP_DIR=${BACKUP_DIR:-/backups}"
  echo "BACKUP_RETENTION=${BACKUP_RETENTION:-30}"
  echo "$CRON_EXPR /usr/local/bin/backup.sh >> /proc/1/fd/1 2>> /proc/1/fd/2"
} > "$CRON_FILE"
chmod 600 "$CRON_FILE"

echo "[backup-sidecar] cron schedule: $CRON_EXPR"
echo "[backup-sidecar] backup dir:    ${BACKUP_DIR:-/backups}"
echo "[backup-sidecar] retention:     ${BACKUP_RETENTION:-30}"

if [ "${BACKUP_RUN_ON_START:-0}" = "1" ]; then
  echo "[backup-sidecar] BACKUP_RUN_ON_START=1 — running an initial backup now"
  /usr/local/bin/backup.sh || echo "[backup-sidecar] initial backup failed (continuing to schedule)"
fi

# -f: foreground; -L /dev/stderr: log to stderr instead of syslog.
exec crond -f -L /dev/stderr
