# ADR 0001: E1–E3 workspace resolution, audit export isolation, and audit-export entitlement gating

**Status:** Accepted  
**Date:** 2026-05-11  
**Context:** Slices E1 (workspace context for API actors), E2 (audit export correctness and isolation), E3 (billing/entitlements — audit export as a plan-gated capability).

## Problem

Cross-cutting concerns were easy to implement incompletely across adapters:

- **E1:** Workspace must be unambiguous and membership-checked before any workspace-scoped work runs; clients must receive stable error codes (`workspace_id_required`, `workspace_not_found_or_not_member`).
- **E2:** Audit export must not leak events across workspaces; HTTP and eventual MCP paths must share the same service-level export and filters.
- **E3:** Audit export is an operator-oriented capability and must be **denied by default** unless the workspace plan explicitly enables it. HTTP and MCP must enforce the same rule and expose aligned error contracts.

## Decisions

### E1 — `workspaceAuth` and resolution

- **Header present (`X-Workspace-ID`):** Resolve membership with `resolveWorkspaceById`. If the actor is not a member, respond with **403** and `{ error: 'workspace_not_found_or_not_member' }`.
- **Header absent:** Call `resolveWorkspaceForActor`.  
  - Exactly one membership → bind `c.var.workspace`.  
  - Zero memberships → treat as **`workspace_id_required`-style failure** via the `none` path (400).  
  - Two or more memberships → **400** `{ error: 'workspace_id_required' }` so clients cannot accidentally operate in the wrong workspace.

Implementation lives in `apps/server/src/auth/middleware.ts`; coverage in `apps/server/test/auth.test.ts` and `apps/server/test/workspaces.test.ts`.

### E2 — Audit export isolation

- Export implementation is centralized in `service/audit-export.ts` (`exportAuditEvents`) and filters by `workspace_id`.
- HTTP routes under the workspace router use the resolved workspace for scoping; tests assert fixture workspace A cannot see workspace B’s event IDs (`apps/server/test/audit_export.test.ts`).

### E3 — Entitlement: `audit_export_enabled`

- **Source of truth:** `workspace_plans.audit_export_enabled` (boolean, default **false** in schema).
- **Evaluation:** `getWorkspacePlan` / `FREE_PLAN_DEFAULTS` in `apps/server/src/service/entitlements.ts` — if there is **no** `workspace_plans` row, **`audit_export_enabled` defaults to false** (same as explicit deny).
- **Enforcement:** `assertAuditExportEnabled(db, workspaceId)` runs **before** `exportAuditEvents` on:
  - `GET /api/audit/export` and `GET /api/audit/export/csv`
  - MCP tool `audit.export` (after membership check, before export).
- **HTTP errors:** **403** with `{ error: 'audit_export_not_enabled', workspace_id }`. `EntitlementLimitError` maps to **403** with `entitlement_limit`, `resource`, and `limit` where applicable.
- **MCP errors:** JSON-RPC **200** transport with body `error.code` **-32003**, `message` **`audit_export_not_enabled`**, and `data.workspace_id`. Entitlement limit uses the same code with `resource` / `limit` in `data`.

### Testing discipline

- Integration tests that expect **successful** audit export **must** insert a `workspace_plans` row with `auditExportEnabled: true` for the fixture workspace, because the database is **truncated** each test (`resetDb` in `test/setup.ts`) and there is otherwise no plan row — which correctly yields “export disabled.”
- Full server tests require `TEST_DATABASE_URL` (see `test/env-setup.ts`).

## Consequences

- **Operators / product:** Enabling audit export for a workspace requires persisting `audit_export_enabled = true` (and any future plan tier that sets it).
- **Clients:** MCP and HTTP callers must handle 403 / `-32003` for gated export; success paths are not available on vanilla free-tier defaults without a plan row flipping the flag.
- **Future work:** Additional entitlements should follow the same pattern: single service assertion, both adapters, shared domain errors, tests that seed explicit plan rows for allow paths.

## References

- `apps/server/src/auth/middleware.ts` — `workspaceAuth`  
- `apps/server/src/service/entitlements.ts` — `assertAuditExportEnabled`, `FREE_PLAN_DEFAULTS`  
- `apps/server/src/adapters/http/routes.ts` — audit export routes and error mapping  
- `apps/server/src/adapters/mcp/server.ts` — `audit.export`, `translateError`  
- `apps/server/test/audit_export.test.ts` — isolation + E3 allow/deny cases  
