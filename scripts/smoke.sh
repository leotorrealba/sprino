#!/bin/sh
# Sprino — full-stack Docker smoke test.
#
# Usage:
#   sh scripts/smoke.sh          # run and tear down on exit
#   KEEP_UP=1 sh scripts/smoke.sh  # leave containers running after success
#
# Requires: docker compose, openssl (via bootstrap.sh), wget or curl.
# Optional: python3 (for token extraction; pure-shell grep fallback used otherwise).

set -eu

# ---------- locate repo root ----------
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT"

log() { printf '[smoke] %s\n' "$*"; }
die() { printf '[smoke] FATAL: %s\n' "$*" >&2; exit 1; }

# ---------- http helpers ----------
# http_get <url> — prints the HTTP status code; returns 0 always.
http_get() {
    _url="$1"
    if command -v wget >/dev/null 2>&1; then
        wget -q --server-response -O /dev/null "$_url" 2>&1 | grep -m1 'HTTP/' | awk '{print $2}'
    elif command -v curl >/dev/null 2>&1; then
        curl -s -o /dev/null -w '%{http_code}' "$_url"
    else
        die "Neither wget nor curl found. Cannot make HTTP requests."
    fi
}

# http_get_auth <url> <token> — like http_get but sends Authorization: Bearer.
http_get_auth() {
    _url="$1"
    _token="$2"
    if command -v wget >/dev/null 2>&1; then
        wget -q --server-response -O /dev/null \
            --header="Authorization: Bearer ${_token}" \
            "$_url" 2>&1 | grep -m1 'HTTP/' | awk '{print $2}'
    elif command -v curl >/dev/null 2>&1; then
        curl -s -o /dev/null -w '%{http_code}' \
            -H "Authorization: Bearer ${_token}" \
            "$_url"
    else
        die "Neither wget nor curl found. Cannot make HTTP requests."
    fi
}

# ---------- polling ----------
# poll_url <url> <max_seconds> <interval_seconds> <label>
poll_url() {
    _url="$1"
    _max="$2"
    _interval="$3"
    _label="$4"
    _elapsed=0
    while [ "$_elapsed" -lt "$_max" ]; do
        _code=$(http_get "$_url" 2>/dev/null || true)
        if [ "$_code" = "200" ]; then
            log "$_label is up (HTTP 200) after ${_elapsed}s"
            return 0
        fi
        log "Waiting for $_label (got '$_code', ${_elapsed}/${_max}s)..."
        sleep "$_interval"
        _elapsed=$(( _elapsed + _interval ))
    done
    die "$_label did not respond with HTTP 200 within ${_max}s (last code: '$_code')."
}

# ---------- cleanup trap ----------
KEEP_UP=${KEEP_UP:-0}
cleanup() {
    if [ "$KEEP_UP" = "1" ]; then
        log "KEEP_UP=1 — leaving containers running."
    else
        log "Tearing down containers..."
        docker compose --profile full down -v --remove-orphans || true
        log "Containers removed."
    fi
}
trap cleanup EXIT

# ---------- bootstrap ----------
log "Running bootstrap.sh --force to generate .env..."
sh bootstrap.sh --force
log ".env generated."

# ---------- start stack ----------
log "Starting full stack (docker compose --profile full up -d --build)..."
docker compose --profile full up -d --build
log "Stack started."

# ---------- wait for server ----------
log "Polling server health at http://localhost:3001/healthz (max 90s)..."
poll_url "http://localhost:3001/healthz" 90 2 "server"

# ---------- wait for web ----------
log "Polling web at http://localhost:3000/ (max 60s)..."
poll_url "http://localhost:3000/" 60 2 "web"

# ---------- extract admin token ----------
log "Extracting admin token from .env..."
ACTORS_JSON=""
# Read the single-quoted value of SPRINO_ACTORS_JSON from .env.
# The line looks like:  SPRINO_ACTORS_JSON='[{"id":"...","token":"..."}]'
# We strip the variable name, the surrounding single quotes, and any trailing comment.
ACTORS_JSON=$(grep -m1 '^SPRINO_ACTORS_JSON=' .env | sed "s/^SPRINO_ACTORS_JSON='\([^']*\)'.*$/\1/")
if [ -z "$ACTORS_JSON" ]; then
    die "Could not extract SPRINO_ACTORS_JSON from .env."
fi

ADMIN_TOKEN=""
if command -v python3 >/dev/null 2>&1; then
    ADMIN_TOKEN=$(printf '%s' "$ACTORS_JSON" | python3 -c 'import json,sys; actors=json.load(sys.stdin); print(actors[0]["token"])')
else
    # Pure-shell fallback: handles both compact ("token":"val") and spaced
    # ("token": "val") JSON, covering bootstrap.sh's shell and python3 paths.
    ADMIN_TOKEN=$(printf '%s' "$ACTORS_JSON" | grep -o '"token" *: *"[^"]*"' | head -1 | sed 's/"token" *: *"\([^"]*\)"/\1/')
fi

if [ -z "$ADMIN_TOKEN" ]; then
    die "Could not extract admin token from SPRINO_ACTORS_JSON."
fi
log "Admin token extracted (length: $(printf '%s' "$ADMIN_TOKEN" | wc -c | tr -d ' '))."

# ---------- authenticated API call ----------
log "Making authenticated GET http://localhost:3001/api/projects..."
API_CODE=$(http_get_auth "http://localhost:3001/api/projects" "$ADMIN_TOKEN" 2>/dev/null || echo "000")
API_CODE=${API_CODE:-000}

if [ "$API_CODE" != "200" ]; then
    die "GET /api/projects returned HTTP $API_CODE (expected 200)."
fi
log "GET /api/projects returned HTTP 200."

# ---------- done ----------
log "Smoke test PASSED."
