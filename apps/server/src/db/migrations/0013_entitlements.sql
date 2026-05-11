-- 0013_entitlements.sql

CREATE TABLE workspace_plans (
  workspace_id         UUID        PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  plan                 TEXT        NOT NULL DEFAULT 'free'
                       CHECK (plan IN ('free', 'pro', 'enterprise')),
  max_projects         INTEGER     NOT NULL DEFAULT 3,
  max_members          INTEGER     NOT NULL DEFAULT 5,
  audit_export_enabled BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO workspace_plans (workspace_id, plan, max_projects, max_members, audit_export_enabled)
SELECT id,
       'free',
       3,
       5,
       FALSE
FROM workspaces
ON CONFLICT (workspace_id) DO NOTHING;
