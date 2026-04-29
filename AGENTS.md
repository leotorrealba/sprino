# AGENTS.md

This repo follows the policies in [docs/git-workflow.md](docs/git-workflow.md).

## For coding agents working in this repo

- Open a PR for every change. Never push directly to the default branch.
- PR titles must follow Conventional Commits (enforced by `pr-title` CI).
- Squash merge only.
- Resolve every review thread before merge. Use the `pr-respond` skill to
  walk unresolved threads with a structured Apply / Challenge / Modify /
  Defer decision.
- Repo policy itself is managed by the `setup-repo-rules` skill. Re-running
  it on this repo is safe and idempotent.

## Project-specific instructions

<!-- Add anything project-specific below. setup-repo-rules will not overwrite this file. -->
