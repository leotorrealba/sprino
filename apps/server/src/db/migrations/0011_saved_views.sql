-- apps/server/src/db/migrations/0011_saved_views.sql
-- D5-P1: saved views + automation rule storage

CREATE TABLE saved_views (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  filters JSONB NOT NULL,
  created_by UUID NOT NULL REFERENCES actors(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX saved_views_project_idx ON saved_views(project_id);

CREATE TABLE automation_rules (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger_field TEXT NOT NULL CHECK (trigger_field IN ('status', 'assignee_id')),
  trigger_value TEXT,
  action_field TEXT NOT NULL CHECK (action_field IN ('status', 'assignee_id')),
  action_value TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID NOT NULL REFERENCES actors(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX automation_rules_project_idx ON automation_rules(project_id);
