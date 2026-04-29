# Git Workflow

Operating manual for `leotorrealba/sprino`.

The promise: **`main` is always releasable.** Everything below exists to keep that promise honest without turning normal work into theater.

## Phase: Solo vs. Collaborator

This repo starts in **solo phase**: one committer, no required reviewers.
The rules below are tuned for that. There is a one-time checklist at the
bottom ("Flip on collaborator mode") that turns on stricter rules when a second committer joins.

## Branching Strategy

Trunk-based development. One long-lived branch (`main`), short-lived branches
for everything else, releases are tags on `main`.

- `main` is the protected source of truth and is always releasable.
- Every change lands through a pull request. No direct commits.
- Feature branches live for hours or days, not weeks.
- Delete branches after merge.
- Releases are git tags (`vX.Y.Z`).

### Branch Format

```text
<type>/<domain>/<short-description>
```

### Branch Types

- `feat` — adds user-facing capability.
- `fix` — corrects broken behavior.
- `test` — adds or repairs test coverage.
- `docs` — documentation only.
- `chore` — maintenance and tooling.
- `refactor` — structure-only changes.
- `perf` — speed or resource improvements.
- `security` — trust-boundary or secret handling fixes.
- `release` — version bump + release notes.

## Pull Request Rules

Every PR answers four questions:

- What changed?
- Why does this matter?
- How was it tested?
- What risk remains?

### Responding to review comments

We do **not** auto-commit fixes for review comments. The Copilot SWE coding
agent (distinct from the `copilot-pull-request-reviewer` comment bot) should be disabled at:

`https://github.com/leotorrealba/sprino/settings/copilot/coding_agent`

Use `/pr-respond` to process unresolved review threads one by one.
For each thread: **Apply**, **Challenge**, **Modify**, or **Defer**.
Branch protection should block merge until unresolved threads are handled.

### Solo-Phase Review Rules

While there is one committer:

- Open a PR for every change.
- CI must be green before merge.
- Self-merge after CI passes.
- Squash merge only.

## Required Status Checks

Required checks for this repo:

- `pr-title`
- `ts-typecheck`
- `ts-test`

## Local Setup (one time)

```bash
git config pull.rebase true
git config merge.ff only
git config rebase.autoStash true
```

## Main Branch Protection

Apply/refresh protection:

```bash
gh api --method PUT \
  repos/leotorrealba/sprino/branches/main/protection \
  --field required_status_checks='{"strict":true,"contexts":["pr-title","ts-typecheck","ts-test"]}' \
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
- Conversation resolution required.
- No force-push, no branch deletion.
- `enforce_admins=true`.

### Stuck-PR escape hatch

Use only for real incidents:

```bash
set -euo pipefail
trap 'gh api -X POST repos/leotorrealba/sprino/branches/main/protection/enforce_admins' EXIT
gh api -X DELETE repos/leotorrealba/sprino/branches/main/protection/enforce_admins
gh pr merge <N> --squash --delete-branch --admin
```

### Flip on collaborator mode

The day a second committer is added, run this once:

```bash
gh api --method PUT \
  repos/leotorrealba/sprino/branches/main/protection \
  --field required_status_checks='{"strict":true,"contexts":["pr-title","ts-typecheck","ts-test"]}' \
  --field enforce_admins=true \
  --field required_pull_request_reviews='{"required_approving_review_count":1,"dismiss_stale_reviews":true,"require_code_owner_reviews":false,"require_last_push_approval":true}' \
  --field restrictions=null \
  --field required_conversation_resolution=true \
  --field allow_force_pushes=false \
  --field allow_deletions=false \
  --field required_linear_history=true
```

## Emergency Override

If admin bypass is used:

1. Document why.
2. Open a follow-up PR with regression test/doc fix.
3. Restore protections if temporarily relaxed.
4. Treat it as an incident.

---

*Last reviewed: 2026-04-29. Re-review when collaboration model changes.*
