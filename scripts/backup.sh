#!/bin/sh
# Sprino — Postgres backup script.
#
# Runs `pg_dump` against the configured database, compresses the output with
# gzip, and writes it to $BACKUP_DIR. After a successful dump the script
# prunes the oldest files so that no more than $BACKUP_RETENTION (default 30)
# backups are kept.
#
# Required env:
#   PGHOST, PGPORT, PGUSER, PGDATABASE  — Postgres connection
#   BACKUP_DIR                          — destination directory
#
# Optional env:
#   PGPASSWORD        — Postgres password. Optional only if .pgpass / trust /
#                       peer auth is configured; required otherwise.
#   BACKUP_RETENTION  — number of backups to keep (default 30)
#   BACKUP_PREFIX     — filename prefix used for both the default filename
#                       and the retention prune glob (default "sprino-").
#                       Override this if you run multiple Sprino instances
#                       writing to the same BACKUP_DIR so each instance
#                       prunes only its own files.
#   BACKUP_FILENAME   — override filename; default ${BACKUP_PREFIX}YYYYMMDD-HHMMSS.sql.gz
#                       (timestamp ensures multiple backups in one day all
#                       survive, instead of overwriting each other). Note:
#                       if you use BACKUP_FILENAME, make sure it begins with
#                       BACKUP_PREFIX so retention pruning still applies.
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

PREFIX="${BACKUP_PREFIX:-sprino-}"

# BACKUP_PREFIX is interpolated into a glob in the retention prune step.
# Restrict it to a safe charset (alnum + dash + underscore + dot) so a
# whitespace or glob metacharacter can't cause word-splitting or match
# unintended files. Also forbid path separators — the prefix is a filename
# component, not a path.
case "$PREFIX" in
  *[!A-Za-z0-9_.-]*|"")
    echo "BACKUP_PREFIX may only contain alphanumerics, '-', '_', '.' (got: '$PREFIX')" >&2
    exit 1
    ;;
esac

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
DEFAULT_NAME="${PREFIX}${TIMESTAMP}.sql.gz"
FILENAME="${BACKUP_FILENAME:-$DEFAULT_NAME}"
TARGET="$BACKUP_DIR/$FILENAME"
TMP="$TARGET.partial"
DUMP_TMP="$TARGET.sql.partial"

echo "[backup] dumping $PGDATABASE@$PGHOST:$PGPORT -> $TARGET"

# Dump to a temporary SQL file first so we can reliably detect pg_dump
# failures in POSIX /bin/sh (no `pipefail`) before compressing the result.
# Without this split, a failing pg_dump piped into gzip still produces a
# valid (but empty/truncated) gzip file and the script would exit 0.
# `--no-owner --no-privileges` keeps the dump portable across users.
if ! pg_dump --no-owner --no-privileges "$PGDATABASE" > "$DUMP_TMP"; then
  rm -f "$DUMP_TMP" "$TMP"
  echo "[backup] pg_dump failed" >&2
  exit 2
fi
if ! gzip -9 < "$DUMP_TMP" > "$TMP"; then
  rm -f "$DUMP_TMP" "$TMP"
  echo "[backup] gzip failed" >&2
  exit 2
fi
rm -f "$DUMP_TMP"

# Sanity-check: gzip integrity must verify before we accept the dump.
if ! gzip -t "$TMP" 2>/dev/null; then
  rm -f "$TMP"
  echo "[backup] gzip integrity check failed" >&2
  exit 2
fi

mv "$TMP" "$TARGET"
SIZE=$(wc -c < "$TARGET" | tr -d ' ')
echo "[backup] wrote $TARGET ($SIZE bytes)"

# Retention: keep the $RETENTION newest files matching ${PREFIX}*.sql.gz,
# delete the rest. Using `ls -t` for portability across busybox/coreutils.
# We avoid `echo "$OLD" | while ...` because in /bin/sh implementations like
# Alpine ash the while-in-pipe runs in a subshell, so an `exit 3` inside it
# wouldn't propagate to the parent process and a prune failure would be
# silently swallowed. A here-doc redirect keeps the loop in the main shell.
# shellcheck disable=SC2012  # we deliberately need timestamp-sorted listing
OLD=$(ls -1t "$BACKUP_DIR"/${PREFIX}*.sql.gz 2>/dev/null | tail -n +"$((RETENTION + 1))" || true)
if [ -n "$OLD" ]; then
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if rm -f "$f"; then
      echo "[backup] pruned $f"
    else
      echo "[backup] failed to prune $f" >&2
      exit 3
    fi
  done <<EOF
$OLD
EOF
fi

echo "[backup] done"
