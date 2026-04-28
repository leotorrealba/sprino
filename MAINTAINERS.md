# Maintainers

## Current maintainers

| Name | GitHub | Role |
|------|--------|------|
| Leonardo Torrealba | [@leotorrealba](https://github.com/leotorrealba) | BDFL, project lead |

## Decision process (v0 era)

Sprino is pre-1.0. While we're shaping the protocol and the reference implementation, decisions are **BDFL-led**:

- Leo has final say on architecture, scope, and the roadmap.
- Disagreements are welcome — bring evidence, propose alternatives, push back in PRs and issues.
- If a decision is reversed, it's reversed in writing (in the issue or PR thread) so the trail is clear.

This is intentional. v0 is a small project that benefits from a single coherent vision more than from consensus overhead. It will not stay this way forever.

## Steering plan for v0.2

When Sprino reaches v0.2 (multi-tenant, real-time, hosted SaaS prep), we plan to:

1. **Form a steering committee** of 3–5 maintainers across both repos (Sprino + Tessera).
2. **Document a lightweight RFC process** for protocol changes (Tessera) and breaking implementation changes (Sprino).
3. **Publish a roadmap** with quarterly milestones rather than weekly phases.
4. **Open the maintainer ladder**: contributors who consistently land high-quality PRs and review others' work get nominated.

Until then, the BDFL model stands.

## Release cadence

- **Patch tags (`v0.0.x`)** ship per phase as we hit milestones. Breaking changes are allowed pre-1.0 but documented in `CHANGELOG.md`.
- **Minor tags (`v0.x.0`)** ship when a coherent set of features lands (e.g., v0.1 = self-hostable single-tenant; v0.2 = multi-tenant + real-time).
- **Tessera versioning is independent** and follows semver strictly from `v0.1.0` onward.

## How to escalate

- **Bug:** open a GitHub issue.
- **Architecture concern:** open a GitHub Discussion with "Architecture" tag, or DM Leo on GitHub.
- **Security:** see [SECURITY.md](./SECURITY.md).
- **Code of conduct:** see [CONTRIBUTING.md](./CONTRIBUTING.md). Maintainers' judgment is final on this repo.

## Becoming a maintainer

There's no fast track. The path is:

1. Land 3–5 substantial PRs (not typo fixes).
2. Review others' PRs constructively for a couple of months.
3. Help triage issues.
4. Get nominated by an existing maintainer.

We'll formalize this when we form the steering committee.
