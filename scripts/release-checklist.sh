#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Sprino — release gate checklist

set -eu

# ── VERSION guard ──────────────────────────────────────────────────────────────
if [ -z "${VERSION:-}" ]; then
  printf 'ERROR: VERSION env var is not set.\n' >&2
  printf 'Usage: VERSION=vX.Y.Z sh scripts/release-checklist.sh\n' >&2
  exit 1
fi

FAILED=0

# ── Gate 1: git working tree is clean ─────────────────────────────────────────
if [ -z "$(git status --porcelain)" ]; then
  printf '✓ git working tree is clean\n'
else
  printf '✗ uncommitted changes present\n'
  FAILED=1
fi

# ── Gate 2: on main branch ────────────────────────────────────────────────────
CURRENT_BRANCH="$(git branch --show-current)"
if [ "$CURRENT_BRANCH" = "main" ]; then
  printf '✓ on main branch\n'
else
  printf '✗ not on main (got: %s)\n' "$CURRENT_BRANCH"
  FAILED=1
fi

# ── Gate 3: CHANGELOG entry ───────────────────────────────────────────────────
if grep -qF "## [$VERSION]" CHANGELOG.md 2>/dev/null; then
  printf '✓ CHANGELOG has entry for %s\n' "$VERSION"
else
  printf '✗ CHANGELOG missing entry for %s\n' "$VERSION"
  FAILED=1
fi

# ── Gate 4: README version reference ─────────────────────────────────────────
if grep -qF "$VERSION" README.md 2>/dev/null; then
  printf '✓ README references %s\n' "$VERSION"
else
  printf '✗ README does not reference %s\n' "$VERSION"
  FAILED=1
fi

# ── Gate 5: typecheck ─────────────────────────────────────────────────────────
if bun run typecheck >/dev/null 2>&1; then
  printf '✓ typecheck passed\n'
else
  printf '✗ typecheck failed\n'
  FAILED=1
fi

# ── Gate 6: tests ─────────────────────────────────────────────────────────────
_TEST_DB_URL="${TEST_DATABASE_URL:-postgres://$(whoami)@localhost:5432/sprino_test}"
if env TEST_DATABASE_URL="$_TEST_DB_URL" bun run test >/dev/null 2>&1; then
  printf '✓ tests passed\n'
else
  printf '✗ tests failed\n'
  FAILED=1
fi

# ── Gate 7: CI / open PRs (optional) ─────────────────────────────────────────
if command -v gh >/dev/null 2>&1 && [ "${CI_CHECK:-}" = "1" ]; then
  if gh pr status >/dev/null 2>&1; then
    printf '✓ gh pr status OK (no blocking open PRs)\n'
  else
    printf '✗ gh pr status check failed\n'
    FAILED=1
  fi
else
  printf '  (skipping CI check — gh not available or CI_CHECK not set)\n'
fi

# ── Summary ───────────────────────────────────────────────────────────────────
if [ "$FAILED" -ne 0 ]; then
  printf '\nRelease gate FAILED. Fix the above before tagging.\n'
  exit 1
else
  printf '\nRelease gate PASSED. Safe to tag %s.\n' "$VERSION"
  exit 0
fi
