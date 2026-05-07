-- apps/server/src/db/migrations/0009_task_hierarchy.sql
--
-- D3: Adds parent_task_id (task hierarchy) and task_dependencies (blocked-by).
--
-- parent_task_id:
--   Self-referential nullable FK. ON DELETE SET NULL means deleting a parent
--   does not cascade-delete children — they become root tasks. Max depth 3 is
--   enforced in service layer, not here.
--
-- task_dependencies:
--   Row (A, B) = "A is blocked by B". Composite PK prevents duplicate edges.
--   ON DELETE CASCADE for both FKs: deleting any task removes all edges
--   touching it. Index on to_task_id enables fast "what tasks does X block?"
--   queries.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS parent_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS task_dependencies (
  from_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  to_task_id   UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (from_task_id, to_task_id)
);

CREATE INDEX IF NOT EXISTS task_dependencies_to_idx
  ON task_dependencies(to_task_id);
