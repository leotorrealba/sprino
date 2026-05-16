# Git Workflow

Operating manual for `leotorrealba/sprino`.

The promise: **`main` is always releasable.** Everything below
exists to keep that promise honest without turning normal work into theater.

## Phase: Solo vs. Collaborator

This repo starts in **solo phase**: one committer, no required reviewers.
The rules below are tuned for that. There is a one-time checklist at the
bottom (["Flip on collaborator mode"](#flip-on-collaborator-mode)) that turns
on the stricter rules the day a second committer joins. Do not skip it; do
not pre-enable it.

## Branching Strategy

Trunk-based development. One long-lived branch (`main`),
short-lived branches for everything else, releases are tags on
`main`. No `release/*` branches, no special `hotfix/*` namespace.

- `main` is the protected source of truth and is always releasable.
- Every change lands through a pull request. No direct commits.
- Feature branches live for hours or days, not weeks. If older than a week,
  rebase on `main` or close.
- Delete branches after merge.
- Releases are git tags (`vX.Y.Z`).
- Urgent production fixes are normal `fix/...` branches, prioritized through
  review. No separate hotfix workflow until there is a real reason for one.

### Branch Format

```text
<type>/<domain>/<short-description>
```

### Branch Types

- `feat` — adds user-facing capability.
- `fix` — corrects broken behavior.
- `test` — adds or repairs test coverage without changing production behavior.
- `docs` — documentation only.
- `chore` — maintenance, dependencies, scripts, repo hygiene.
- `refactor` — structure changes without behavior changes.
- `perf` — speed, memory, or bundle/build size.
- `security` — privacy, secret, permission, or trust-boundary fix.
- `release` — version bump + release notes.

### Branch Domains

**Customize this list per project.** Pick the part of the codebase the branch
primarily touches. Suggested starting points:

- `app` — broad product behavior.
- `api` — HTTP/RPC surface.
- `ui` — frontend, design-system implementation.
- `build` — packaging, CI, release plumbing.
- `docs` — documentation-only changes.
- `tests` — test-only changes.

If a branch touches more than one domain, pick the domain that owns the
**risk**.

## Commit Style

**Inside a feature branch**, commit however helps you think. Tiny, messy, WIP
commits are fine — squash-on-merge cleans them up.

**The PR title** is the commit that lands on `main`. It must
follow Conventional Commits and is enforced by CI:

```text
<type>(<domain>): <imperative summary, lowercase, no trailing period>
```

Examples:

```text
fix(ui): preserve scroll position on tab switch
feat(api): add cursor pagination
test(build): cover release-tag dry-run path
```

The `<type>` follows the list above. Imperative mood ("add", "fix",
"remove"), not past tense.

Always:

- Never commit secrets, `.env` files, API keys, build artifacts, or local
  machine state.
- Do not mix formatting-only churn with behavior changes in the same commit.
- The squashed PR commit body should answer *why*, not just *what changed*.
- If a commit broke tests temporarily inside a branch, fix it before merge —
  the squashed result must be green.

## Pull Request Rules

Every PR answers four questions:

- What changed?
- Why does this matter?
- How was it tested?
- What risk remains?

The repo's [pull request template](../.github/pull_request_template.md)
encodes those four questions; fill it in for every PR.

### Responding to review comments

We do **not** auto-commit fixes for review comments. The Copilot SWE coding
agent (distinct from the `copilot-pull-request-reviewer` comment bot) is
disabled at:

`https://github.com/leotorrealba/sprino/settings/copilot/coding_agent`

Keep it off.

Use the `/pr-respond` skill to walk every unresolved review thread one at a
time. For each thread it gets an independent challenge from a different model
(Codex), then prompts you to **Apply**, **Challenge**, **Modify**, or
**Defer**. Apply edits the file, commits with a co-author trailer, posts a
reply with the SHA, and resolves the thread. Challenge posts your rebuttal
but leaves the thread open on purpose — the reviewer responds. Branch
protection blocks merging until every thread resolves, which is the gate we
actually want.

Never resolve a thread you disagree with just to clear the merge button. If a
reviewer is wrong and won't engage, document the disagreement in the PR
description and use the escape hatch below.

### Automatic Copilot review

Every PR also auto-requests review from `copilot-pull-request-reviewer` via
[`.github/workflows/copilot-review.yml`](../.github/workflows/copilot-review.yml).
This is a second pair of eyes on every PR; you can dismiss its comments if
they are not useful, but the request happens unconditionally.

Copilot Code Review must be enabled at the org/account level once (in
GitHub UI: Settings → Copilot → Code review). The skill cannot toggle that
flag; it only requests review on each PR.

### Solo-Phase Review Rules

While there is one committer:

- Open a PR for every change. No direct pushes to `main`.
- CI must be green before merge. CI failing = do not merge.
- You self-merge after CI passes. No human review is required because there
  is no second human.
- Squash merge only.

When a second committer joins, see ["Flip on collaborator mode"](#flip-on-collaborator-mode).

### Required Status Checks

CI runs on every PR via [`.github/workflows/pr.yml`](../.github/workflows/pr.yml)
and the universal [`.github/workflows/pr-title.yml`](../.github/workflows/pr-title.yml),
and must pass before merge:

- `pr-title`
- `ts-typecheck`
- `ts-lint`
- `ts-test`

## Local Setup (one time)

Make `git pull` rebase by default and refuse non-fast-forward merges so
trunk-based discipline is automatic:

```bash
git config pull.rebase true
git config merge.ff only
git config rebase.autoStash true
```

## Daily Loop

```bash
git switch main && git pull
git switch -c fix/ui/some-bug

# ...do work, commit freely...

git push -u origin fix/ui/some-bug
gh pr create --fill
```

After merge:

```bash
git switch main
git pull
git branch -d fix/ui/some-bug
```

GitHub deletes the remote branch automatically after squash merge.

## Releases

There are no release branches. To cut a release:

1. Open a PR that bumps version files. Branch: `release/vX.Y.Z`. Title:
   `release: vX.Y.Z`. Body lists user-visible changes since the last tag.
2. Merge the release PR (squash, like any other).
3. Tag the merge commit on `main`:

   ```bash
   git switch main && git pull
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

If a release artifact has a critical bug, fix it on `main`
(normal `fix/...` branch), merge, then tag `vX.Y.Z+1`. The previous tag
stays; do not rewrite history.

## Main Branch Protection

`main` rejects direct pushes. Protection is applied by the
`/setup-repo-rules` skill, which runs:

```bash
gh api --method PUT \
  repos/leotorrealba/sprino/branches/main/protection \
  --field required_status_checks='{"strict":true,"contexts":["pr-title","ts-typecheck","ts-lint","ts-test"]}' \
  --field enforce_admins=true \
  --field required_pull_request_reviews=null \
  --field restrictions=null \
  --field required_conversation_resolution=true \
  --field allow_force_pushes=false \
  --field allow_deletions=false \
  --field required_linear_history=true
```

What this enables:

- PR required (no direct push).
- Linear history (squash-merge only).
- Conversation resolution required — unresolved review threads block merge.
- No force-push, no branch deletion.
- `enforce_admins=true` — rules apply to the owner too. The whole point of
  branch protection is that it actually binds.
- `required_pull_request_reviews=null` — no human review required (solo).

**Stuck-PR escape hatch.** When a PR genuinely cannot land (flaky CI you've
verified is harmless, a bot comment you can't resolve, etc.), the escape is
a 30-second admin-disable window:

```bash
set -euo pipefail
trap 'gh api -X POST repos/leotorrealba/sprino/branches/main/protection/enforce_admins' EXIT
gh api -X DELETE repos/leotorrealba/sprino/branches/main/protection/enforce_admins
gh pr merge <N> --squash --delete-branch --admin
```

The friction is the feature. If you find yourself running this more than once
a month, the underlying problem isn't the protection — it's the workflow.

### Flip on collaborator mode

The day a second committer is added, run this once:

```bash
gh api --method PUT \
  repos/leotorrealba/sprino/branches/main/protection \
  --field required_status_checks='{"strict":true,"contexts":["pr-title","ts-typecheck","ts-lint","ts-test"]}' \
  --field enforce_admins=true \
  --field required_pull_request_reviews='{"required_approving_review_count":1,"dismiss_stale_reviews":true,"require_code_owner_reviews":false,"require_last_push_approval":true}' \
  --field restrictions=null \
  --field required_conversation_resolution=true \
  --field allow_force_pushes=false \
  --field allow_deletions=false \
  --field required_linear_history=true
```

What changes:

- 1 approving review required, stale approvals dismissed on new commits, last
  pusher cannot self-approve.

Also do at flip time:

- Fill in [`CODEOWNERS`](../CODEOWNERS) if certain paths should always be
  reviewed by a specific person.
- Audit any open PRs that pre-date the flip and ensure they get a real review.

## Release Gating

Before tagging a release, run the release gate checklist to verify the repo is
in a clean, releasable state:

```bash
VERSION=vX.Y.Z sh scripts/release-checklist.sh
```

The script runs seven gate checks in order and exits 0 only when all pass:

1. **Git clean** — working tree has no uncommitted changes.
2. **On main** — you must be on the `main` branch.
3. **CHANGELOG entry** — `CHANGELOG.md` contains a `## [vX.Y.Z]` heading for
   the target version.
4. **README version** — `README.md` references the target version string.
5. **Typecheck** — `bun run typecheck` succeeds.
6. **Tests** — `bun run test` succeeds against the configured test database.
7. **GitHub CLI reachability (optional)** — if `gh` is installed and `CI_CHECK=1` is
   set, runs `gh pr status` to verify the CLI can reach the GitHub API. Skipped otherwise.

**Convention:** do not run `git tag` until the gate exits 0. The tag is the
public signal that the release is good; make it mean something.

### Test database requirement

Gates 5–6 run the real test suite, so `TEST_DATABASE_URL` must point to a
running Postgres instance:

```bash
TEST_DATABASE_URL=postgres://you@localhost:5432/sprino_test \
  VERSION=vX.Y.Z sh scripts/release-checklist.sh
```

If the variable is not set the script falls back to
`postgres://$(whoami)@localhost:5432/sprino_test`.

### Post-tag validation

After tagging, run the Docker end-to-end smoke test to confirm the published
image boots and the health endpoint responds:

```bash
sh scripts/smoke.sh
```

`smoke.sh` spins up the full `docker-compose` stack, waits for the server to
become healthy, hits `/health`, and tears down. A passing smoke run is the
final signal that the release is shippable.

## Emergency Override

Direct pushes are blocked. If admin bypass is ever used:

1. Write down why bypass was required (in the follow-up PR description).
2. Open a follow-up PR that adds a regression test or documents the workaround.
3. Restore branch protection if it was relaxed.
4. Treat the bypass as an incident, even if nothing visibly broke.

---

*Last reviewed: 2026-04-29 via `/setup-repo-rules`. Re-review when a
second committer joins or before the first public release.*
