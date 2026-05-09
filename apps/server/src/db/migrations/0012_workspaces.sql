-- 0012_workspaces.sql

CREATE TABLE workspaces (
  id          UUID        PRIMARY KEY,
  name        TEXT        NOT NULL,
  slug        TEXT        NOT NULL UNIQUE,
  created_by  UUID        REFERENCES actors(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX workspaces_slug_idx ON workspaces(slug);

CREATE TABLE workspace_members (
  workspace_id UUID  NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id     UUID  NOT NULL REFERENCES actors(id)     ON DELETE CASCADE,
  role         TEXT  NOT NULL DEFAULT 'member'
                     CHECK (role IN ('admin', 'member')),
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, actor_id)
);

CREATE INDEX workspace_members_actor_idx     ON workspace_members(actor_id);
CREATE INDEX workspace_members_workspace_idx ON workspace_members(workspace_id);

ALTER TABLE projects
  ADD COLUMN workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;

CREATE INDEX projects_workspace_idx ON projects(workspace_id);

-- Bootstrap: default workspace
INSERT INTO workspaces (id, name, slug, created_by)
  VALUES ('00000000-0000-7000-8000-000000000001', 'Default', 'default', NULL);

-- Backfill existing projects
UPDATE projects
  SET workspace_id = '00000000-0000-7000-8000-000000000001'
  WHERE workspace_id IS NULL;

ALTER TABLE projects ALTER COLUMN workspace_id SET NOT NULL;

-- Backfill existing actors as members (admin role mirrors existing actors.role)
INSERT INTO workspace_members (workspace_id, actor_id, role)
SELECT '00000000-0000-7000-8000-000000000001', id, role::text
FROM actors
ON CONFLICT DO NOTHING;
