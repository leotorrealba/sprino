# Weeks 3-8 Task Breakdown — Multi-Agent Orchestration

**Status:** Ready for sub-agent dispatch  
**Total streams:** 18 tasks across 6 weeks  
**Parallelism:** 2-3 streams per week  
**Merge pattern:** dependency-ordered per week  

---

## WEEK 3: Multi-actor + Activity Feed (3 parallel streams)

### Stream 3A: Multi-actor system
**Owner:** Claude Opus Agent  
**Worktree:** `.claude/worktrees/week3-stream-a`  
**Estimated effort:** 4-5 hours  

**Goal:**  
Parse `SPRINO_ACTORS_JSON` from env, validate schema, build per-actor token auth middleware, support multiple human + agent actors.

**Requirements**
- Env parsing: validate `SPRINO_ACTORS_JSON` JSON structure at startup (id, kind, display_name, token, agent_runtime?)
- Registry: in-memory actor lookup by token (pre-load from env on boot)
- Auth middleware: tokenAuth resolves `Authorization: Bearer <token>` → actor entry or 401
- Fail-fast on malformed env
- Affected modules: `apps/server/src/auth/registry.ts`, `apps/server/src/auth/middleware.ts`

**Success Criteria**
- [ ] `SPRINO_ACTORS_JSON='[{"id":"...","kind":"human","display_name":"Leo","token":"leo-token","agent_runtime":null}]'` parses at startup
- [ ] Bad JSON or missing required fields → server fails to start with clear error
- [ ] `curl -H "Authorization: Bearer leo-token" /healthz` → 200 (auth succeeds)
- [ ] `curl -H "Authorization: Bearer bad-token" /healthz` → 401 Unauthorized
- [ ] Vitest: 100% coverage of registry.ts + middleware.ts
- [ ] Vitest: test malformed JSON, missing token, multiple actors, agent_runtime field

**Dependencies**
- None (independent)

**Not in scope**
- UI for actor switching (Week 3 Stream C)
- Event attribution to actors (Week 3 Stream B)
- Token rotation playbook (Week 7)

**Test command**
```bash
cd apps/server
TEST_DATABASE_URL=postgres://leotorrealba@localhost:5432/sprino_test \
  SPRINO_ACTORS_JSON='[...]' bun test --grep "auth|registry"
```

---

### Stream 3B: Event log wiring
**Owner:** Claude Opus Agent  
**Worktree:** `.claude/worktrees/week3-stream-b`  
**Estimated effort:** 5-6 hours  
**Blocks:** Stream 3C (activity feed frontend needs events.list endpoint)

**Goal:**  
Wire append-only event log: every task mutation writes an event before updating materialized state. Events are the source of truth; task status is a projection.

**Requirements**
- Event schema (already in DB from Week 1): id, task_id, actor_id, kind ('created'|'status_changed'|'assigned'|...), payload (jsonb), operation_id, created_at
- Task creation writes: INSERT task → INSERT event (same transaction, task INSERT first per FK constraint)
- Task status update writes: INSERT event with status_changed kind + before/after in payload → UPDATE task.status
- Event queries: `events.list(projectId, limit?, offset?)` returns paginated events
- `tasks.get()` enriches response with recent_events (last 5 events for this task)
- Affected modules: `apps/server/src/service/tasks.ts`, `apps/server/src/db/schema.ts`, `apps/server/src/adapters/http/routes.ts`

**Success Criteria**
- [ ] createTask() writes task + event in single transaction (task first, event second)
- [ ] updateStatus() writes status_changed event BEFORE updating task.status
- [ ] events.list(projectId) returns paginated events (100 per page), sorted newest-first
- [ ] task.get(taskId) includes recent_events array (last 5)
- [ ] Vitest: task creation → event log contains matching 'created' event with correct payload
- [ ] Vitest: status update → event log contains 'status_changed' event with before/after
- [ ] Vitest: 4-actor concurrent race test: all 4 update same task, all 4 events logged in order, last one wins (version conflict on others)
- [ ] 100% coverage of tasks.ts mutation paths

**Dependencies**
- **REQUIRES Stream 3A:** Auth middleware must resolve actor_id before events can be attributed
- **Can run parallel:** doesn't affect Stream 3C (they work on different schema)

**Not in scope**
- Frontend event rendering (Stream 3C)
- Event filtering/search (Week 5)
- Rich event formatting (Week 6 polish)
- Realtime LISTEN/NOTIFY (Week 6)

**Test command**
```bash
cd apps/server
TEST_DATABASE_URL=postgres://leotorrealba@localhost:5432/sprino_test bun test --grep "event|concurrent"
```

---

### Stream 3C: Activity feed frontend + events.list endpoint
**Owner:** Claude Opus Agent  
**Worktree:** `.claude/worktrees/week3-stream-c`  
**Estimated effort:** 4-5 hours  

**Goal:**  
Build `/api/events` REST endpoint and React activity feed component. Poll every 2-3 seconds for now (SSE fallback deferred to Week 6).

**Requirements**
- REST endpoint: `GET /api/events?project_id=<uuid>&limit=50&offset=0` returns paginated event list
  - Filters: by project_id (required), by task_id (optional)
  - Response: `{ events: [{ id, task_id, actor_id, kind, payload, created_at, actor: { display_name, kind } }] }`
- React component: `<ActivityFeed projectId={...} />` 
  - Polls `/api/events` every 2-3 seconds
  - Renders event list with human-readable summaries: "Leo created Task X", "Claude marked Task Y as done"
  - Newest events at top
  - Simple styling (no rich formatting yet)
- Integrate into main App.tsx below task list
- Affected modules: `apps/server/src/adapters/http/routes.ts`, `apps/web/src/components/ActivityFeed.tsx`, `apps/web/src/App.tsx`

**Success Criteria**
- [ ] `GET /api/events?project_id=<uuid>` returns paginated event list with actor details
- [ ] 401 auth required
- [ ] Component renders without errors
- [ ] Polling updates in real-time (~2-3s delay)
- [ ] Smoke: create task → activity feed shows "Created Task X" within 3 seconds
- [ ] Smoke: update status → activity feed shows "Marked Task Y as done" within 3 seconds
- [ ] Vitest: events.list endpoint returns correct schema and pagination
- [ ] Vitest: activity feed component renders with mock event data

**Dependencies**
- **REQUIRES Stream 3B:** events.list endpoint must exist first
- **REQUIRES Stream 3A:** auth middleware for 401 checks
- **Can run parallel:** code to the mock API response while 3B is being built

**Not in scope**
- Real-time SSE (Week 6)
- Event filtering UI (Week 5)
- Rich event formatting, diffs (Week 6+)
- Timestamps, timezones (defer)

**Test command**
```bash
cd apps/server
TEST_DATABASE_URL=postgres://leotorrealba@localhost:5432/sprino_test bun test --grep "events/list"

cd apps/web
npm run test  # if vitest is wired for web
```

---

## WEEK 4: Rich Agent Context + Concurrency (3 parallel streams)

### Stream 4A: agent_context response field
**Owner:** Claude Opus Agent  
**Worktree:** `.claude/worktrees/week4-stream-a`  
**Estimated effort:** 4-5 hours  

**Goal:**  
Enrich `task.get()` response with structured agent context: related tasks, recent events, repo refs. Cap at 32KB and paginate when truncated.

**Requirements**
- `task.get(taskId)` response includes `agent_context` object:
  ```json
  {
    "task": { ... },
    "agent_context": {
      "related_tasks": [...],      // tasks blocking/blocked-by, up to 10
      "recent_events": [...],       // last 20 events on this project (already added Week 3)
      "repo_refs": [],              // placeholder for Week 5+
      "truncated": false,
      "next_page_tokens": null
    }
  }
  ```
- When serialized > 32KB: truncate related_tasks and recent_events, set `truncated: true`, provide opaque `next_page_tokens` for pagination
- New endpoints: `tasks/{taskId}/related_tasks?limit=...&offset=...`, `tasks/{taskId}/events?limit=...&offset=...`
- Affected modules: `apps/server/src/service/tasks.ts`, `apps/server/src/adapters/http/routes.ts`, `apps/server/src/domain/task.ts`

**Success Criteria**
- [ ] task.get(taskId) returns agent_context with related_tasks, recent_events, repo_refs
- [ ] Serialized response ≤ 32KB (measure with JSON.stringify().length)
- [ ] When > 32KB: truncate gracefully, set truncated=true, provide page tokens
- [ ] Pagination endpoints work: GET /api/tasks/{id}/related_tasks?limit=5&offset=10
- [ ] Vitest: agent_context for small task < 32KB
- [ ] Vitest: large task with 100+ events → truncated=true, next_page_tokens present
- [ ] Vitest: pagination tokens work (call related_tasks with token, get next page)
- [ ] 100% coverage of truncation logic

**Dependencies**
- None (doesn't block other streams)

**Not in scope**
- Related tasks *detection* logic (blocking, blocked-by relationships) — use placeholder, expand Week 5+
- Repo_refs population (Week 5+)
- SSE for agent_context updates

**Test command**
```bash
cd apps/server
TEST_DATABASE_URL=postgres://leotorrealba@localhost:5432/sprino_test bun test --grep "agent_context|truncat"
```

---

### Stream 4B: Optimistic concurrency (version + if_match)
**Owner:** Claude Opus Agent  
**Worktree:** `.claude/worktrees/week4-stream-b`  
**Estimated effort:** 4-5 hours  

**Goal:**  
Implement optimistic locking: every task has a `version` integer. Mutations require `if_match: <version>`. On mismatch, return 409 Conflict with current task state.

**Requirements**
- Task schema: add `version: integer` column (already there from Week 1, ensure not nullable)
- Version increments by 1 on every mutation (status change, assignment, etc.)
- Mutating endpoints (PATCH /api/tasks/:id/status, etc.) require `if_match: <version>` in request body
- On mismatch: return 409 Conflict with full current task in response body (so client can re-fetch and decide)
- Concurrent writes to same task by 4 actors: 3 get 409, 1 succeeds, version is 1 higher
- Affected modules: `apps/server/src/service/tasks.ts`, `apps/server/src/adapters/http/routes.ts`, `apps/server/src/domain/task.ts`

**Success Criteria**
- [ ] task.version starts at 1, increments on each mutation
- [ ] PATCH /api/tasks/:id/status without if_match → 400 Bad Request
- [ ] PATCH with if_match matching current version → 200 OK, version incremented
- [ ] PATCH with if_match not matching → 409 Conflict, response body contains current task with new version
- [ ] Vitest: happy path (version match) → update succeeds
- [ ] Vitest: stale version (mismatch) → 409 with current state
- [ ] Vitest: concurrent updates (4 actors, same task, all send version=1): 3 get 409, 1 gets 200, final version=2
- [ ] Vitest: sequential retries work (client gets 409, re-fetches, retries with new version, succeeds)
- [ ] 100% coverage of version logic

**Dependencies**
- None (independent stream)

**Not in scope**
- Client-side retry logic (that's in MCP tool implementations)
- Distributed transaction handling (single-instance PoC)
- Version reset logic

**Test command**
```bash
cd apps/server
TEST_DATABASE_URL=postgres://leotorrealba@localhost:5432/sprino_test bun test --grep "version|concurrency|409"
```

---

### Stream 4C: Concurrency stress test
**Owner:** Claude Opus Agent  
**Worktree:** `.claude/worktrees/week4-stream-c`  
**Estimated effort:** 3-4 hours  
**Requires:** Streams 4A + 4B must merge first

**Goal:**  
Comprehensive concurrency test: simulate 4 concurrent actors (humans + agents) updating the same task. Verify all conflicts resolve correctly, no double-mutations, event log is consistent.

**Requirements**
- Test scenario: create 1 task, 4 actors each try to change status simultaneously
  - Actor 1 sets status → doing
  - Actor 2 sets status → done
  - Actor 3 sets status → blocked
  - Actor 4 sets status → todo
- Expected: 3 get 409, 1 succeeds, final status is whichever succeeded, event log has 4 events (1 successful, 3 conflict attempts)
- Verify: no data corruption, version is correct, actor_id is correct on each event
- New file: `apps/server/test/concurrency.test.ts`
- Affected modules: vitest test file only

**Success Criteria**
- [ ] Test creates task, spawns 4 concurrent PATCH requests to same task
- [ ] Exactly 1 PATCH returns 200, other 3 return 409
- [ ] Final task.status matches the one that succeeded (or last-write semantics clear)
- [ ] Event log shows 4 events: 1 successful status_changed, 3 conflict attempts (captured as events or logged separately)
- [ ] task.version = 2 (incremented once)
- [ ] No race conditions, no duplicate writes
- [ ] Test runs <5s

**Dependencies**
- **REQUIRES Streams 4A + 4B:** agent_context and version logic must exist
- **No impact on 4A or 4B** (test-only, doesn't change code)

**Not in scope**
- Distributed systems tests (multi-instance, split-brain)
- Stress test with 100+ concurrent requests (out of scope for PoC)

**Test command**
```bash
cd apps/server
TEST_DATABASE_URL=postgres://leotorrealba@localhost:5432/sprino_test bun test concurrency.test.ts
```

---

## WEEK 5: Protocol v0.1 Milestone (2 parallel streams)

### Stream 5A: Spec stabilization
**Owner:** Claude Opus Agent  
**Worktree:** `tessera/` (cross-repo, sibling directory)  
**Estimated effort:** 4-5 hours  

**Goal:**  
Freeze protocol schemas, document deprecation policy, publish v0.1.0 tag.

**Requirements**
- Review all JSON Schemas from weeks 1-4: task.create, task.get, task.update_status, actor, project, event, operation
- Lock schemas (no breaking changes during v0.1.x)
- Add SPEC.md sections:
  - Versioning: semver policy (breaking = major, additive = minor/patch)
  - Deprecation: 90-day notice period before breaking changes
  - Migration guide template: how v0.0.x → v0.1.x (mostly additive, no breaking changes week 1-4)
  - Conformance: reference implementation must pass all fixtures
- Update README in tessera/ repo
- Create CHANGELOG.md: summarize what changed from v0.0.1 → v0.1.0
- Affected modules: `tessera/SPEC.md`, `tessera/README.md`, `tessera/CHANGELOG.md`, `tessera/conformance/*.json`

**Success Criteria**
- [ ] All JSON Schemas locked (no more additions in v0.1.x)
- [ ] SPEC.md documents versioning and deprecation policy
- [ ] CHANGELOG.md lists all verbs, all schema changes, breaking changes (there are none v0.0→v0.1)
- [ ] Migration guide written (backward compatible, additive only)
- [ ] README updated: status = "v0.1.0 stable", reference impl = Sprino v0.1.0
- [ ] Tag tessera v0.1.0, push to GitHub

**Dependencies**
- None (repo work only)

**Not in scope**
- Governance/steering committee (defer to v0.2)
- Protocol extensions (defer to v0.2)

---

### Stream 5B: Conformance fixtures expansion
**Owner:** Claude Opus Agent  
**Worktree:** `tessera/` (cross-repo)  
**Estimated effort:** 4-5 hours  
**Requires:** Stream 5A (schema lock)

**Goal:**  
Expand conformance fixtures to cover all verbs and edge cases. Reference impl (Sprino) must pass all fixtures in CI.

**Requirements**
- Fixtures (JSON request/response pairs in `tessera/conformance/`):
  - `task.create.json`: happy path + idempotent replay
  - `task.get.json`: with agent_context, truncation
  - `task.update_status.json`: happy path + version conflict (409)
  - `task.events_list.json`: pagination
  - `actors.list.json` (new): list actors in project
  - `projects.list.json` (new): list all projects
  - Edge cases: missing fields, invalid UUIDs, stale version, etc.
- CI: reference impl runs `bun test conformance` and validates against all fixtures
- Affected modules: `tessera/conformance/*.json`, `sprino/apps/server/test/conformance.test.ts`

**Success Criteria**
- [ ] Conformance fixtures cover all 6 verbs: create, get, update_status, events.list, actors.list, projects.list
- [ ] Each fixture includes: happy path, idempotent replay, at least 1 edge case
- [ ] Sprino conformance tests pass 100% of fixtures
- [ ] CI enforces conformance on every PR to both repos
- [ ] Fixtures are stable (no changes in v0.1.x)

**Dependencies**
- **REQUIRES Stream 5A:** schemas must be locked first
- **Can run in parallel:** doesn't affect Sprino codebase

**Not in scope**
- MCP-specific conformance (beyond what's in the JSON fixtures)
- Performance benchmarks

---

## WEEK 6: Buffer + Hardening (3 parallel streams)

### Stream 6A: Backup/restore workflow
**Owner:** Claude Opus Agent  
**Worktree:** `.claude/worktrees/week6-stream-a`  
**Estimated effort:** 3-4 hours  

**Goal:**  
Implement nightly `pg_dump` cron and restoration playbook. Tested end-to-end.

**Requirements**
- Daily cron job (runs at 2am local time): `pg_dump sprino_dev | gzip > /backups/sprino-$(date +%Y%m%d).sql.gz`
- Backup retention: keep last 30 backups
- Restore playbook: docs/RESTORE.md with steps:
  1. Stop the backend (`docker-compose stop`)
  2. Restore: `gunzip < backup.sql.gz | psql sprino_dev`
  3. Start backend
- Affected modules: `docker-compose.yml` (add backup volume/service), `scripts/backup.sh`, `docs/RESTORE.md`, `apps/server/package.json` (backup cron script)

**Success Criteria**
- [ ] Backup script creates `.sql.gz` files in `/backups/`
- [ ] Backup file is valid (can be restored)
- [ ] Restore playbook tested: dump → restore → verify data matches
- [ ] Docs are clear, non-technical person could follow
- [ ] Backup does not require downtime

**Dependencies**
- None (independent)

**Not in scope**
- Incremental backups
- Multi-region replication
- Automated restore testing in CI (manual test OK for v1)

---

### Stream 6B: Resource limits + pagination
**Owner:** Claude Opus Agent  
**Worktree:** `.claude/worktrees/week6-stream-b`  
**Estimated effort:** 3-4 hours  

**Goal:**  
Add rate limits and pagination guards. Prevent runaway queries (e.g., someone requests 1M events).

**Requirements**
- Resource limits:
  - `events.list`: max 1000 events per call (required pagination)
  - `tasks.list`: max 500 tasks per call
  - `agents.list`: max 100 agents per call
- Default limits if not specified: 50 per call
- Enforced at service layer (before DB query)
- Error response if limit exceeded: 400 Bad Request with helpful message
- Affected modules: `apps/server/src/service/*.ts`, `apps/server/src/adapters/http/routes.ts`, `apps/server/src/domain/pagination.ts` (new)

**Success Criteria**
- [ ] GET /api/events?limit=2000 → 400 "limit must be ≤1000"
- [ ] GET /api/events (no limit param) → defaults to 50
- [ ] GET /api/events?limit=500 → returns exactly 500 or fewer
- [ ] Pagination works: limit + offset parameters respected
- [ ] Vitest: all list endpoints enforce max limits

**Dependencies**
- None (independent)

**Not in scope**
- User-configurable limits
- Rate limiting by token (Week 7+)

---

### Stream 6C: Realtime fallback (SSE failover to polling)
**Owner:** Claude Opus Agent  
**Worktree:** `.claude/worktrees/week6-stream-c`  
**Estimated effort:** 4-5 hours  

**Goal:**  
If SSE connection drops, fall back to polling at 10s interval. Activity feed stays live either way.

**Requirements**
- Frontend: SSE connection to `/api/events/stream?project_id=X`
  - If connection drops: start polling GET /api/events?project_id=X every 10s
  - If polling succeeds (200): continue polling
  - If polling fails (5 consecutive 5xx): show error to user, retry slower
  - SSE reconnect attempt every 30s
- Backend: `/api/events/stream` endpoint that streams events via SSE
  - Stream format: each line is `data: {event JSON}\n\n`
  - Client can close and reconnect without losing events (already polled on reconnect)
- Affected modules: `apps/web/src/components/ActivityFeed.tsx`, `apps/server/src/adapters/http/routes.ts`

**Success Criteria**
- [ ] SSE connection streams events in real-time
- [ ] Manual test: kill SSE connection → frontend switches to polling → receives new events
- [ ] Manual test: kill polling → shows error, retries
- [ ] Vitest: SSE endpoint returns valid event stream format
- [ ] Vitest: polling fallback fetches new events after reconnect

**Dependencies**
- None (independent)

**Not in scope**
- Postgres LISTEN/NOTIFY (deferred to Week 6 originally; still deferred if time-tight)
- WebSocket upgrade (defer to v0.2)
- Multiple simultaneous SSE clients (PoC single-user)

---

## WEEK 7: Self-host Packaging + External Test (2 parallel streams)

### Stream 7A: Docker Compose setup + bootstrap.sh
**Owner:** Claude Opus Agent  
**Worktree:** `.claude/worktrees/week7-stream-a`  
**Estimated effort:** 4-5 hours  

**Goal:**  
Package everything for 30-min self-host: `docker compose up` brings up working Sprino.

**Requirements**
- `docker-compose.yml`: services for postgres + backend + frontend
  - Postgres 16 image (postgres:16-alpine)
  - Backend (Dockerfile.server): built from apps/server
  - Frontend (Dockerfile.web): built from apps/web
  - Network: all services can communicate
  - Volumes: postgres data persists
- `bootstrap.sh`: generates env, seeds first project, prints connection details
  - Prompts for admin token (generates UUIDv7 if not provided)
  - Seeds one actor (the admin human)
  - Creates one project (sprino)
  - Prints: "Sprino ready at http://localhost:3000, token: ..."
- Dockerfiles already exist (Week 1-4); update for consistency
- .env.example updated with all required vars
- Affected modules: `docker-compose.yml`, `bootstrap.sh`, `Dockerfile.server`, `Dockerfile.web`, `.env.example`

**Success Criteria**
- [ ] `docker compose up` starts all services
- [ ] Backend healthz responds 200 at http://localhost:3001/healthz
- [ ] Frontend loads at http://localhost:3000
- [ ] Postgres is initialized with schema
- [ ] Manual test: create task via API, see it in web UI
- [ ] `bootstrap.sh` runs successfully, generates valid env
- [ ] Startup time <2 minutes on fresh machine

**Dependencies**
- None (independent)

**Not in scope**
- Multi-node docker-compose (load balancer, clustering)
- Health checks in compose file (nice to have, not required)
- Kubernetes manifests

---

### Stream 7B: Documentation + token rotation playbook
**Owner:** Claude Opus Agent  
**Worktree:** `.claude/worktrees/week7-stream-b`  
**Estimated effort:** 3-4 hours  

**Goal:**  
Document everything for external user self-hosting. Clear 30-min walkthrough.

**Requirements**
- `README.md` (update existing): self-hosting section:
  1. Prerequisites (Docker, 2GB RAM, 20GB disk)
  2. Clone repo
  3. `bash bootstrap.sh`
  4. `docker compose up`
  5. Open http://localhost:3000, paste token
  6. Create tasks
- `docs/TOKEN-ROTATION.md`: playbook for rotating per-actor tokens
  - Edit `.env` file
  - Update `SPRINO_ACTORS_JSON`
  - Restart backend (`docker compose restart backend`)
  - Tokens take effect immediately
  - Old operations still valid (30-day retention)
- `docs/RESTORE.md`: restore from backup (already written in Week 6A)
- `CHANGELOG.md` (Sprino): summarize week 7 changes
- Affected modules: `README.md`, `docs/TOKEN-ROTATION.md`, `docs/RESTORE.md`, `CHANGELOG.md`

**Success Criteria**
- [ ] README self-hosting section is clear, step-by-step
- [ ] TOKEN-ROTATION.md covers: why rotate, when to rotate, step-by-step
- [ ] A non-technical person could self-host in 30 min following the README
- [ ] All docs are current (no outdated version refs)
- [ ] No external links to private resources

**Dependencies**
- **REQUIRES Stream 7A:** bootstrap.sh must exist and work
- **Can run in parallel:** documentation doesn't block anything

**Not in scope**
- Video tutorials (Week 8+)
- Troubleshooting guide (defer to v0.2)
- Kubernetes docs

---

## WEEK 8: Open Source Release (2 parallel streams)

### Stream 8A: Licensing + open source prep
**Owner:** Claude Opus Agent  
**Worktree:** `.claude/worktrees/week8-stream-a`  
**Estimated effort:** 3-4 hours  

**Goal:**  
Apply AGPL v3 to Sprino, finalize MIT on Tessera, prepare for public release.

**Requirements**
- Sprino repo:
  - Add `LICENSE` file: AGPL v3 (copy from https://opensource.org/license/agpl-v3)
  - Add AGPL header to all source files in apps/server (first 2 lines of each .ts file):
    ```typescript
    // SPDX-License-Identifier: AGPL-3.0-or-later
    // Sprino — reference implementation of Tessera
    ```
  - Add `CONTRIBUTING.md`: how to contribute, PR process, code of conduct
  - Add `MAINTAINERS.md`: who maintains, decision process, release cadence
  - Add `SECURITY.md`: how to report security issues privately
  - Confirm LICENSE in tessera/ is MIT
- Affected modules: all source files + new license docs

**Success Criteria**
- [ ] AGPL v3 headers on all .ts files in apps/server (generate via script, review)
- [ ] CONTRIBUTING.md explains PR workflow, CLA (none for v1), testing
- [ ] MAINTAINERS.md names Leo as BDFL, outlines steering committee plan for v0.2
- [ ] SECURITY.md: email to leotorrealba@gmail.com for private disclosure
- [ ] No license conflicts (check dependencies)
- [ ] tessera/LICENSE is MIT

**Dependencies**
- None (independent)

**Not in scope**
- CLA (not needed for v1)
- Patent grants (covered by AGPL/MIT)

---

### Stream 8B: Release notes + announcement draft
**Owner:** Claude Opus Agent  
**Worktree:** `.claude/worktrees/week8-stream-b`  
**Estimated effort:** 3-4 hours  

**Goal:**  
Document what shipped, why it matters, how to get started. Draft announcement.

**Requirements**
- `CHANGELOG.md` (Sprino): summarize weeks 1-8
  - What shipped: tasks, projects, events, actors, MCP, web UI, Docker, protocol
  - Breaking changes: none (v0 → v0 is pre-release)
  - Performance: baseline numbers if measured
  - Known limitations: token rotation requires restart, SSE not LISTEN/NOTIFY, etc.
- `CHANGELOG.md` (Tessera): protocol v0.1.0 is stable, no breaking changes planned for v0.1.x
- Announcement draft (blog post or LinkedIn):
  - Hook: "I built Sprino so my AI agents can manage project state alongside humans"
  - Problem: agents currently invisible in PM tools
  - Solution: MCP-first, append-only events, open protocol
  - What's next: looking for teams to test v0.1, planning v0.2 with real-time + comments
  - Link to GitHub, tessera spec
  - Honest about what's not ready (no cloud SaaS, auth is basic, self-host only)
- Affected modules: `CHANGELOG.md` (both repos), `ANNOUNCEMENT.md` (blog draft)

**Success Criteria**
- [ ] CHANGELOG lists all verbs, features, known limitations
- [ ] Announcement is honest, concise, links to resources
- [ ] Tone is founder voice, not corporate speak
- [ ] No overpromising (doesn't claim "production-ready" or "ready for teams of 100")

**Dependencies**
- **REQUIRES Stream 8A:** licensing must be finalized first (affects announcement tone)

**Not in scope**
- Publishing the announcement (user does this)
- YouTube/video (defer)
- Press release

---

## Dependency Graph

```
WEEK 3:
  3A (auth) ──────────┐
                      ├─→ 3B (events) ──→ 3C (feed frontend)
                      └──────────────────→ 3C (feed frontend)

WEEK 4:
  4A (agent_context) ─┐
                      ├─→ 4C (stress test)
  4B (version) ───────┘

WEEK 5:
  5A (spec lock) ──→ 5B (conformance)

WEEK 6:
  6A (backup) ─┐
              ├─→ (independent, merge in any order)
  6B (limits) ─┤
              ├─→
  6C (SSE) ────┘

WEEK 7:
  7A (docker) ──→ 7B (docs)

WEEK 8:
  8A (license) ──→ 8B (announcement)
```

---

## Merge & Release Process

### Per-week merge checklist (Friday EOD)

```bash
#!/bin/bash
set -e
WEEK=$1  # pass "3", "4", etc.

echo "=== WEEK $WEEK MERGE & RELEASE ==="
cd /Users/leotorrealba/Development/Sprino

# Merge order: follow dependency graph
case $WEEK in
  3) STREAMS=("week3-stream-a" "week3-stream-b" "week3-stream-c") ;;
  4) STREAMS=("week4-stream-a" "week4-stream-b" "week4-stream-c") ;;
  5) STREAMS=("week5-stream-a" "week5-stream-b") ;;
  6) STREAMS=("week6-stream-a" "week6-stream-b" "week6-stream-c") ;;
  7) STREAMS=("week7-stream-a" "week7-stream-b") ;;
  8) STREAMS=("week8-stream-a" "week8-stream-b") ;;
esac

# Merge each stream
for stream in "${STREAMS[@]}"; do
  echo "Merging $stream..."
  git merge ".claude/worktrees/$stream" --no-edit
  git worktree remove ".claude/worktrees/$stream"
done

# Integration test
echo "Running integration tests..."
TEST_DATABASE_URL=postgres://leotorrealba@localhost:5432/sprino_test bun test

# Tag release
TAG="v0.0.$WEEK"
git tag "$TAG"
git push origin "$TAG"
echo "Tagged $TAG"

# Cleanup
echo "=== WEEK $WEEK COMPLETE ==="
```

### Release cadence

- **Tags:** `v0.0.3` (end of week 3), `v0.0.4`, ..., `v0.1.0` (end of week 8)
- **Docker images:** Tag GHCR image with version on each tag
- **Protocol:** Tessera v0.1.0 tagged in week 5, referenced from week 8 release

---

## Agent Dispatch Instructions

### For each stream, send this template to the sub-agent:

```
You are assigned Stream [N] for Week [W]. 

TASK: [goal from above]

REQUIREMENTS:
[copy relevant requirements]

SUCCESS CRITERIA:
[copy checklist]

DEPENDENCIES:
[note what must merge first]

FILE CHANGES:
- [affected files/modules]

TEST COMMAND:
[run this to verify]

CONTEXT:
- You're working in worktree .claude/worktrees/[name]
- When done, commit your changes with: git commit -m "feat: [stream name] — week [W]"
- Push to origin: git push
- Notify me when ready to merge

START CODING.
```

---

## Status Tracking

Print this template weekly to track progress:

```
WEEK 3 STATUS
─────────────
Stream 3A (auth):        [ ] assigned [ ] in progress [ ] done
Stream 3B (events):      [ ] assigned [ ] in progress [ ] done
Stream 3C (feed):        [ ] assigned [ ] in progress [ ] done

Integration test:        [ ] passing
v0.0.3 tagged:           [ ] yes
Dogfood verified:        [ ] yes

NEXT: Merge complete, start week 4 streams Monday
```

---

## Notes

- **Reuse this file for weeks 3-8.** Copy the template per stream, send to agents with their specific task.
- **Watch dependencies.** If Stream 3A is late, 3B can code in parallel (but will need to mock actor_id). Only the merge waits.
- **Halfway-by-Wednesday rule:** If a stream is <50% done by EOD Wednesday, drop lowest-priority sub-item and ship the rest.
- **External user (Week 7):** Line up your external tester by week 4 EOD. Ask them: "Can I send you a test instance in 3 weeks?"
- **Dogfood journal (Week 4 & 6):** Schedule 30min Friday EOD weeks 4 and 6 to write honest assessment: what worked, what didn't, any surprises.

---

*Generated for Week 1-2 completion → Weeks 3-8 multi-agent execution*
