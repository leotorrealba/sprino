#!/bin/sh
# Sprino bootstrap — generate a working .env for self-host.
#
# Idempotent: re-running with an existing .env is a no-op unless --force
# is passed. Writes a fresh .env with random tokens and stream secret so
# nothing ships with the dev defaults committed in .env.example.
#
# Requires: openssl (for random secrets and IDs). Python is optional and
# only used for cleaner JSON escaping if available; otherwise we fall back
# to a pure-shell path. Generated identifiers are UUIDv4-compatible —
# Postgres accepts any v1-v8 in a `uuid` column and the seed rows don't
# need the temporal ordering of v7.
#
# Usage:
#   sh bootstrap.sh                    # generate .env if missing
#   sh bootstrap.sh --force            # overwrite existing .env
#   ADMIN_NAME="Alice" sh bootstrap.sh # customize the admin display name

set -eu

# ---------- arg parsing ----------
FORCE=0
for arg in "$@"; do
    case "$arg" in
        --force|-f) FORCE=1 ;;
        --help|-h)
            sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "bootstrap.sh: unknown argument: $arg" >&2
            exit 2
            ;;
    esac
done

# ---------- prereq check ----------
if ! command -v openssl >/dev/null 2>&1; then
    echo "bootstrap.sh: openssl is required (for random tokens)." >&2
    exit 1
fi

# ---------- locate repo root ----------
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

ENV_FILE=".env"
if [ -f "$ENV_FILE" ] && [ "$FORCE" -ne 1 ]; then
    echo "bootstrap.sh: $ENV_FILE already exists. Use --force to overwrite."
    echo "Existing values were left untouched. To regenerate, run:"
    echo "    sh bootstrap.sh --force"
    exit 0
fi

# ---------- helpers ----------
gen_secret() {
    # 32 bytes hex = 64 chars, well above the 32-char floor enforced
    # by the SSE secret loader.
    openssl rand -hex 32
}

gen_token() {
    # 24 random bytes -> exactly 32 base64 chars (no padding because
    # 192 bits is a multiple of 6). Translate '+/' to base64url's '-_'
    # so the token stays URL- and Authorization-header-safe without
    # changing length or biasing the alphabet.
    openssl rand -base64 24 | tr '+/' '-_' | tr -d '\n'
}

gen_uuid() {
    # Prefer Python's uuid.uuid4 for a syntactically-valid UUID. Postgres
    # `uuid` accepts any v1-v8; we don't need the temporal ordering of v7
    # for these one-off seed rows.
    if command -v python3 >/dev/null 2>&1; then
        python3 -c 'import uuid; print(uuid.uuid4())'
    else
        # Fallback: 16 random bytes formatted as a UUID with the v4 + RFC
        # 4122 variant bits. POSIX-portable.
        hex=$(openssl rand -hex 16)
        # set version (bits 12-15 of time_hi_and_version) to 4
        v=$(printf '%s' "$hex" | cut -c13-16 | tr 'a-f' 'A-F')
        v=$(printf '4%s' "$(printf '%s' "$v" | cut -c2-4)")
        # set variant (bits 6-7 of clock_seq_hi_and_reserved) to 10xx
        c=$(printf '%s' "$hex" | cut -c17-20)
        c1=$(printf '%s' "$c" | cut -c1)
        case "$c1" in
            [0-3]) c1=8 ;; [4-7]) c1=9 ;; [8-9aAbB]) c1=a ;; *) c1=b ;;
        esac
        c=$(printf '%s%s' "$c1" "$(printf '%s' "$c" | cut -c2-4)")
        printf '%s-%s-%s-%s-%s\n' \
            "$(printf '%s' "$hex" | cut -c1-8)" \
            "$(printf '%s' "$hex" | cut -c9-12)" \
            "$v" \
            "$c" \
            "$(printf '%s' "$hex" | cut -c21-32)"
    fi
}

# ---------- gather inputs ----------
ADMIN_NAME=${ADMIN_NAME:-Admin}
PROJECT_SLUG=${PROJECT_SLUG:-sprino}
PROJECT_NAME=${PROJECT_NAME:-Sprino}

# Validate display names (ADMIN_NAME, PROJECT_NAME) use only characters
# that are safe to embed in a single-quoted dotenv value (no apostrophes,
# no shell metas, no newlines) and in a JSON string without escaping
# (no double quotes, no backslashes). This sidesteps the entire
# quoting-edge-case minefield: if your admin really is named O'Connor,
# edit .env by hand or set ADMIN_NAME after manual escaping.
SAFE_NAME_RE='^[A-Za-z0-9 ._-]+$'
for pair in "ADMIN_NAME=$ADMIN_NAME" "PROJECT_NAME=$PROJECT_NAME"; do
    name=${pair%%=*}
    val=${pair#*=}
    if ! printf '%s' "$val" | grep -Eq "$SAFE_NAME_RE"; then
        echo "bootstrap.sh: $name contains characters that are unsafe to" >&2
        echo "  embed in .env without complex escaping. Allowed: A-Z a-z 0-9" >&2
        echo "  space . _ -" >&2
        echo "  Got: $val" >&2
        exit 1
    fi
done

# PROJECT_SLUG has a stricter shape: it must match the server's domain
# schema (apps/server/src/domain/index.ts → projectSlug regex), which
# only allows lowercase alphanumerics and internal hyphens. If we let
# the looser SAFE_NAME_RE through here, bootstrap.sh would happily seed
# a project whose slug then 422s on every /api/projects/resolve?slug=...
# call. Keep these two regexes in sync with the server.
SAFE_SLUG_RE='^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
if ! printf '%s' "$PROJECT_SLUG" | grep -Eq "$SAFE_SLUG_RE"; then
    echo "bootstrap.sh: PROJECT_SLUG must be lowercase alphanumerics and" >&2
    echo "  hyphens only (no leading/trailing hyphen)." >&2
    echo "  This matches the server's projectSlug schema." >&2
    echo "  Got: $PROJECT_SLUG" >&2
    exit 1
fi

ADMIN_ACTOR_ID=$(gen_uuid)
ADMIN_TOKEN=$(gen_token)
PROJECT_ID=$(gen_uuid)
STREAM_SECRET=$(gen_secret)

# ---------- write .env ----------
# Build SPRINO_ACTORS_JSON via python (json escaping is harder than it
# looks in pure shell when display names can contain spaces). The earlier
# charset validation guarantees no apostrophes, double quotes, or
# backslashes here — so both the python and pure-sh paths are safe.
if command -v python3 >/dev/null 2>&1; then
    ACTORS_JSON=$(ADMIN_ACTOR_ID="$ADMIN_ACTOR_ID" ADMIN_TOKEN="$ADMIN_TOKEN" ADMIN_NAME="$ADMIN_NAME" \
        python3 -c '
import json, os
print(json.dumps([{
    "id": os.environ["ADMIN_ACTOR_ID"],
    "kind": "human",
    "display_name": os.environ["ADMIN_NAME"],
    "token": os.environ["ADMIN_TOKEN"],
    "agent_runtime": None,
}]))')
else
    ACTORS_JSON=$(printf '[{"id":"%s","kind":"human","display_name":"%s","token":"%s","agent_runtime":null}]' \
        "$ADMIN_ACTOR_ID" "$ADMIN_NAME" "$ADMIN_TOKEN")
fi

cat > "$ENV_FILE" <<EOF
# Sprino — generated by bootstrap.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Re-run with --force to regenerate. Tokens below are one-time secrets;
# treat .env like a private key.

# ---------- Database ----------
# Inside Docker Compose, the server reaches Postgres via the service name.
DATABASE_URL=postgres://sprino:sprino@postgres:5432/sprino_dev

# ---------- Auth ----------
# Single-quoted so embedded JSON double-quotes survive dotenv parsing.
SPRINO_ACTORS_JSON='${ACTORS_JSON}'

# ---------- Realtime (SSE) ----------
SPRINO_STREAM_SECRET=${STREAM_SECRET}

# ---------- Project bootstrap ----------
SPRINO_DEFAULT_PROJECT_ID=${PROJECT_ID}
SPRINO_DEFAULT_PROJECT_SLUG='${PROJECT_SLUG}'
SPRINO_DEFAULT_PROJECT_DISPLAY_NAME='${PROJECT_NAME}'

# ---------- Server ----------
PORT=3001
NODE_ENV=production
LOG_LEVEL=info
EOF

chmod 600 "$ENV_FILE"

# ---------- summary ----------
cat <<EOF

✓ Wrote $ENV_FILE (mode 600)

Next:
    docker compose --profile full up -d
    open http://localhost:3000

Sign in with:
    Name:  ${ADMIN_NAME}
    Token: ${ADMIN_TOKEN}

The token is also stored in $ENV_FILE under SPRINO_ACTORS_JSON.
Keep that file out of version control — it's already in .gitignore.

EOF
