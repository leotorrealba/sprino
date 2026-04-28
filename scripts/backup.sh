#!/bin/sh
# Sprino — Postgres backup script.
#
# Runs `pg_dump` against the configured database, compresses the output with
# gzip, and writes it to $BACKUP_DIR. After a successful dump the script
# prunes the oldest files so that no more than $BACKUP_RETENTION (default 30)
# backups are kept.
#
# Required env:
#   PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE  — Postgres connection
#   BACKUP_DIR                                      — destination directory
#
# Optional env:
#   BACKUP_RETENTION  — number of backups to keep (default 30)
#   BACKUP_FILENAME   — override filename; default sprino-YYYYMMDD-HHMMSS.sql.gz
#                       (timestamp ensures multiple backups in one day all
#                       survive, instead of overwriting each other)
#
# Exit codes:
#   0  success
#   1  config error (missing required env)
#   2  pg_dump failed (no file written)
#   3  retention prune failed (dump kept)

set -eu

: "${PGHOST:?PGHOST not set}"
: "${PGPORT:?PGPORT not set}"
: "${PGUSER:?PGUSER not set}"
: "${PGDATABASE:?PGDATABASE not set}"
: "${BACKUP_DIR:?BACKUP_DIR not set}"

# PGPASSWORD is optional only if .pgpass / trust auth is configured. We don't
# enforce it here so the script works with both.

RETENTION="${BACKUP_RETENTION:-30}"
case "$RETENTION" in
  ''|*[!0-9]*) echo "BACKUP_RETENTION must be a positive integer" >&2; exit 1 ;;
esac
if [ "$RETENTION" -lt 1 ]; then
  echo "BACKUP_RETENTION must be >= 1" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
DEFAULT_NAME="sprino-${TIMESTAMP}.sql.gz"
FILENAME="${BACKUP_FILENAME:-$DEFAULT_NAME}"
TARGET="$BACKUP_DIR/$FILENAME"
TMP="$TARGET.partial"

echo "[backup] dumping $PGDATABASE@$PGHOST:$PGPORT -> $TARGET"

# Dump to a .partial file first so a half-written file never appears
# in the retention list (and is never picked up by a parallel restore).
# `--no-owner --no-privileges` keeps the dump portable across users.
if ! pg_dump --no-owner --no-privileges "$PGDATABASE" | gzip -9 > "$TMP"; then
  rm -f "$TMP"
  echo "[backup] pg_dump failed" >&2
  exit 2
fi

# Sanity-check: gzip integrity must verify before we accept the dump.
if ! gzip -t "$TMP" 2>/dev/null; then
  rm -f "$TMP"
  echo "[backup] gzip integrity check failed" >&2
  exit 2
fi

mv "$TMP" "$TARGET"
SIZE=$(wc -c < "$TARGET" | tr -d ' ')
echo "[backup] wrote $TARGET ($SIZE bytes)"

# Retention: keep the $RETENTION newest files matching sprino-*.sql.gz,
# delete the rest. Using `ls -t` for portability across busybox/coreutils.
# shellcheck disable=SC2012  # we deliberately need timestamp-sorted listing
OLD=$(ls -1t "$BACKUP_DIR"/sprino-*.sql.gz 2>/dev/null | tail -n +"$((RETENTION + 1))" || true)
if [ -n "$OLD" ]; then
  echo "$OLD" | while IFS= read -r f; do
    [ -z "$f" ] && continue
    if rm -f "$f"; then
      echo "[backup] pruned $f"
    else
      echo "[backup] failed to prune $f" >&2
      exit 3
    fi
  done
fi

echo "[backup] done"
