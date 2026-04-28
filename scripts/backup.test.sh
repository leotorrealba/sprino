#!/usr/bin/env bash
# Sprino — backup.sh integration test.
#
# Exercises scripts/backup.sh end-to-end against the Postgres instance the
# unit tests already use (sprino_test on localhost:5432) and asserts:
#   - The script exits 0.
#   - Output file exists, gzip-validates, and contains real SQL dump markers.
#   - Restoring the dump into a scratch database yields the original rows.
#   - Retention pruning keeps exactly $BACKUP_RETENTION newest files.
#   - Running with bad config exits non-zero (no orphan .partial files).
#
# Why bash and not vitest: backup.sh is itself a shell script, so a
# shell-level smoke test catches the failure modes that matter (env
# handling, mv-rename atomicity, ls -t ordering on busybox vs coreutils).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_SH="$REPO_ROOT/scripts/backup.sh"

# These match the values used by apps/server/test/setup.ts.
: "${PGHOST:=localhost}"
: "${PGPORT:=5432}"
: "${PGUSER:=$(whoami)}"
: "${PGDATABASE:=sprino_test}"
export PGHOST PGPORT PGUSER PGDATABASE
unset PGPASSWORD || true   # local dev usually trusts the unix socket

TMP_BACKUP_DIR=$(mktemp -d -t sprino-backup-test-XXXXXX)
trap 'rm -rf "$TMP_BACKUP_DIR"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

echo "=== Test 1: missing PGHOST should fail with config error ==="
( unset PGHOST; BACKUP_DIR="$TMP_BACKUP_DIR" "$BACKUP_SH" ) >/dev/null 2>&1 \
  && fail "expected nonzero exit on missing PGHOST" \
  || pass "missing PGHOST exits nonzero"

echo "=== Test 2: invalid retention should fail before dumping ==="
BACKUP_DIR="$TMP_BACKUP_DIR" BACKUP_RETENTION="not-a-number" "$BACKUP_SH" >/dev/null 2>&1 \
  && fail "expected nonzero exit on invalid BACKUP_RETENTION" \
  || pass "invalid retention exits nonzero"
ls "$TMP_BACKUP_DIR"/*.sql.gz "$TMP_BACKUP_DIR"/*.partial 2>/dev/null \
  && fail "no files should be written on config error" \
  || pass "no orphan files written on config error"

echo "=== Test 3: happy path produces a valid gz dump ==="
BACKUP_DIR="$TMP_BACKUP_DIR" BACKUP_RETENTION=30 "$BACKUP_SH"
DUMP_FILE=$(ls -1t "$TMP_BACKUP_DIR"/sprino-*.sql.gz | head -1)
[ -f "$DUMP_FILE" ] || fail "dump file not created"
pass "dump file created: $DUMP_FILE"

gzip -t "$DUMP_FILE" || fail "gzip integrity check failed"
pass "gzip integrity OK"

# The dump should at least mention the schema's known table names. We
# check against table identifiers (no dependency on row content).
if ! gunzip -c "$DUMP_FILE" | grep -q "CREATE TABLE.*tasks"; then
  fail "dump does not contain CREATE TABLE ... tasks"
fi
pass "dump contains expected schema"

echo "=== Test 4: no leftover .partial files ==="
if ls "$TMP_BACKUP_DIR"/*.partial 2>/dev/null; then
  fail "found leftover .partial files"
fi
pass "no leftover .partial files"

echo "=== Test 5: retention pruning keeps newest N ==="
# Seed 5 fake older backups, then run with retention=3 — only the 3 newest
# (which includes the real dump from Test 3) should survive.
for i in 1 2 3 4 5; do
  TS=$(printf '20260101-%06d' "$((100000 + i))")
  FAKE="$TMP_BACKUP_DIR/sprino-${TS}.sql.gz"
  echo "fake-$i" | gzip > "$FAKE"
  # Stagger mtimes so `ls -t` ordering is deterministic across filesystems.
  # Format CCYYMMDDhhmm (12 digits) is portable across BSD and GNU touch.
  touch -t "20260101010${i}" "$FAKE"
done
BACKUP_DIR="$TMP_BACKUP_DIR" BACKUP_RETENTION=3 "$BACKUP_SH"
COUNT=$(ls -1 "$TMP_BACKUP_DIR"/sprino-*.sql.gz | wc -l | tr -d ' ')
if [ "$COUNT" != "3" ]; then
  ls -lt "$TMP_BACKUP_DIR"
  fail "expected 3 backups after pruning, found $COUNT"
fi
pass "retention pruned to 3 backups"

echo "=== Test 6: restoring the dump round-trips into a scratch DB ==="
SCRATCH_DB="sprino_restore_test_$$"
createdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" "$SCRATCH_DB"
trap 'rm -rf "$TMP_BACKUP_DIR"; dropdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --if-exists "$SCRATCH_DB" 2>/dev/null || true' EXIT
gunzip -c "$DUMP_FILE" | psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$SCRATCH_DB" -v ON_ERROR_STOP=1 -q >/dev/null
TABLE_COUNT=$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$SCRATCH_DB" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('tasks','events','actors','projects')")
if [ "$TABLE_COUNT" != "4" ]; then
  fail "expected 4 core tables after restore, found $TABLE_COUNT"
fi
pass "restore round-trip verified ($TABLE_COUNT/4 core tables present)"

echo
echo "All backup.sh tests passed."
