# Git Workflow — leotorrealba/sprino

This document describes the standardized git workflow, branch protection rules, and CI checks that apply to this repository.

## Overview

**Main branch:** `main`

**Required checks before merge:**
- `pr-title` — PR titles must follow Conventional Commits (e.g., `feat(api):`, `fix:`, `docs:`, `chore:`)
- `ts-typecheck` — TypeScript type checking (all workspaces)
- `ts-test` — TypeScript tests (@sprino/server with isolated test database)

**Branch protection rules on `main`:**
- Require pull request review: disabled
- Dismiss stale PR approvals: N/A
- Require status checks to pass: required (all checks above)
- Require branches to be up to date before merging: required (strict mode)
- Require conversation resolution before merging: required
- Require linear history: required
- Require signed commits: disabled
- Allow force pushes: disabled
- Allow deletions: disabled

## Workflow

1. **Create a feature branch off `main`:**
   ```bash
   git checkout main
   git pull
   git checkout -b feat/description-of-feature
   ```

2. **Make commits with clear, atomic changes:**
   ```bash
   git commit -m "feat(scope): short description
   
   Longer explanation if needed. Wrap at 72 chars."
   ```
   **Commit message format:** Start with a Conventional Commit type:
   - `feat:` — new feature
   - `fix:` — bug fix
   - `docs:` — documentation only
   - `chore:` — build, deps, config, no code change
   - `refactor:` — code restructure, no new feature
   - `perf:` — performance optimization
   - `test:` — test changes only
   - `security:` — security fix
   - `release:` — version bump

3. **Push your branch and create a pull request:**
   ```bash
   git push -u origin feat/description-of-feature
   gh pr create --draft # or open GitHub web UI
   ```

4. **Address PR feedback:**
   ```bash
   # Make changes in response to review
   git add .
   git commit -m "fix: address feedback on X"
   git push
   # Do NOT force-push to main; do NOT amend published commits
   ```

5. **Merge once CI passes and conflicts are resolved:**
   ```bash
   # GitHub web UI: "Squash and merge"
   # OR command line: git will reject force-push and direct push to main
   ```
   - Squash merges are used (all commits on the branch → one commit on main)
   - Head branches are auto-deleted after merge
   - Linear history is enforced (no merge commits)

## CI Checks

### `pr-title` — Conventional Commits validation
Ensures PR titles are structured (e.g., `feat:`, `fix: (scope):`) so the merge commit message is useful.

### `ts-typecheck` — TypeScript type checking
Runs `bun typecheck` across all workspaces. Must pass before merge.

**To fix locally:**
```bash
bun typecheck
# or fix files and re-run
```

### `ts-test` — Server tests
Runs `bun test` in @sprino/server against an isolated test database. Must pass before merge.

**To fix locally:**
```bash
# Requires local test DB
createdb sprino_test 2>/dev/null || true
TEST_DATABASE_URL=postgres://$(whoami)@localhost:5432/sprino_test bun test
```

**Skip tests:** Not allowed. Tests are required on every PR. If a test is flaky or broken, fix it in the PR.

## Troubleshooting

### "Can't push to main / branch protection prevented push"
This is intentional. All changes must go through a PR.

### "Merge button is disabled"
Check the PR page; it shows which checks are failing. Click "Details" on a failed check to see the error.

### "Your branch has diverged from upstream"
You (or someone else) force-pushed to your feature branch. Don't do that; create a new branch if needed. Direct pushes to `main` are blocked.

### "Merge conflicts"
Resolve locally, commit (do not amend), and push:
```bash
git merge main
# resolve conflicts in your editor
git add .
git commit  # no -m, just describe the conflict resolution
git push
```

## Seeing Your Changes

After your PR is merged to `main`:
- The code is live in the `main` branch
- CI runs on every push to `main` (for monitoring)
- Deployment is handled separately (see README)

## Questions?

See the main [README](../README.md) for project structure. For CI-specific questions, check the workflow file at `.github/workflows/pr.yml`.
