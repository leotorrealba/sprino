# Security policy

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email **leotorrealba@gmail.com** with:

- A description of the vulnerability
- Steps to reproduce (or a proof-of-concept)
- The affected version (commit SHA or tag)
- Your assessment of impact (data exposure, auth bypass, RCE, etc.)
- Whether you'd like to be credited in the fix announcement

You should hear back within **5 business days**. If you don't, please email again — Gmail spam filters are imperfect.

## What's in scope

- Anything in this repository (`leotorrealba/sprino`)
- The published Docker images we maintain
- The bootstrap script (`bootstrap.sh`)

## What's out of scope

- The protocol spec ([leotorrealba/tessera](https://github.com/leotorrealba/tessera)) — that's a documentation repo. Issues there should be public.
- Third-party dependencies — please report to upstream first. If the issue affects Sprino directly (we use the dep in a vulnerable way), we want to know.
- Self-hosted Sprino instances we don't run. We can advise but can't patch your deployment.
- Social engineering, physical access, denial-of-service through resource exhaustion that requires admin tokens.

## Disclosure timeline

We aim for **coordinated disclosure**:

1. We acknowledge receipt within 5 business days.
2. We work on a fix and a CVE (if applicable). Critical issues target a 14-day fix window; less severe issues target 30–60 days.
3. We notify you when a fix is ready, ideally before public release.
4. We publish a security advisory on GitHub and credit you (unless you'd rather stay anonymous).

If a vulnerability is being actively exploited in the wild, we may shorten this timeline to ship a fix immediately. If you've gone public with a vulnerability without coordinating, we'll patch as fast as we can but make no promises about credit.

## Scope of guarantees

Sprino is **pre-1.0** and explicitly self-hosted. We don't run a hosted SaaS yet. The threat model assumes:

- Bearer-token auth (rotation supported, but tokens themselves are sensitive)
- Postgres is on the same trusted network as the server
- The operator is responsible for HTTPS termination, firewall, and OS-level patching

If a vulnerability requires breaking one of those baseline assumptions to exploit, it's lower priority than something exploitable from a default deployment.
