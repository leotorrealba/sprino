-- apps/server/src/db/migrations/0008_task_rank.sql
--
-- D2: Adds explicit per-column rank ordering to tasks.
--
-- Design notes:
-- - rank is scoped per workflow_column_id. Each column has independent
--   1-based integers. DEFAULT 0 is safe for existing tasks — they all start
--   at rank 0 and are renumbered on first reorder.
-- - The composite index on (workflow_column_id, rank) makes per-column
--   ordered fetches fast (the primary query pattern for board rendering).

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS rank integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS tasks_rank_column_idx ON tasks(workflow_column_id, rank);
