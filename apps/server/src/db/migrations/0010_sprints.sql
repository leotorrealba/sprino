-- D4: Adds sprints, sprint_tasks tables and tasks.points column.
--
-- sprints:
--   One active sprint per project enforced in service layer (not here).
--   version + updated_at follow the same optimistic-concurrency pattern as tasks.
--
-- sprint_tasks:
--   Junction table. ON DELETE CASCADE on both FKs: deleting a sprint or task
--   removes the membership row. sprint_tasks_task_idx enables fast
--   "which sprint is this task in?" queries.
--
-- tasks.points:
--   Nullable integer >= 0. Null = unestimated.
--   Burndown uses task count when any task in the sprint lacks points;
--   switches to sum-of-points when all tasks have a value.

CREATE TYPE sprint_status AS ENUM ('planning', 'active', 'completed');

CREATE TABLE IF NOT EXISTS sprints (
  id          UUID PRIMARY KEY,
  project_id  UUID NOT NULL REFERENCES projects(id),
  name        VARCHAR(200) NOT NULL,
  status      sprint_status NOT NULL DEFAULT 'planning',
  starts_on   DATE NOT NULL,
  ends_on     DATE NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  created_by  UUID NOT NULL REFERENCES actors(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sprints_project_id_idx ON sprints(project_id);
CREATE INDEX IF NOT EXISTS sprints_status_idx ON sprints(project_id, status);

CREATE TABLE IF NOT EXISTS sprint_tasks (
  sprint_id  UUID NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
  task_id    UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sprint_id, task_id)
);

CREATE INDEX IF NOT EXISTS sprint_tasks_task_idx ON sprint_tasks(task_id);

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS points INTEGER CHECK (points >= 0);
