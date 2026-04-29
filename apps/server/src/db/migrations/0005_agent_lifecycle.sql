-- 0005_agent_lifecycle.sql
--
-- Agent lifecycle storage for B2 internal lifecycle support. Transition
-- rules stay in the service layer; this migration only adds the persistent
-- primitives future heartbeat/deactivate behavior needs.
--
-- Compatibility:
-- - Additive only: no existing API payloads change in this packet.
-- - Existing rows backfill to 'active' so current actor behavior remains
--   unchanged until lifecycle transition services land.
-- - last_heartbeat_at stays NULL until the first successful heartbeat.
--   Later expiry logic MUST treat NULL as "no heartbeat observed yet" and
--   fall back to the agent row's created_at rather than inventing an eager
--   timestamp in this storage-only packet.
-- - lifecycle_state uses 'inactive' as the single non-active storage state
--   for now. Later packets may distinguish why an agent became inactive in
--   service logic and docs, but B2-P1 intentionally persists only the
--   active vs not-active boundary.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'actor_lifecycle_state'
  ) THEN
    CREATE TYPE actor_lifecycle_state AS ENUM ('active', 'inactive');
  END IF;
END
$$;

ALTER TABLE actors
ADD COLUMN IF NOT EXISTS lifecycle_state actor_lifecycle_state;

UPDATE actors
SET lifecycle_state = 'active'
WHERE lifecycle_state IS NULL;

ALTER TABLE actors
ALTER COLUMN lifecycle_state SET DEFAULT 'active';

ALTER TABLE actors
ALTER COLUMN lifecycle_state SET NOT NULL;

ALTER TABLE actors
ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamp with time zone;

ALTER TABLE actors
ADD COLUMN IF NOT EXISTS deactivated_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS actors_lifecycle_state_idx
ON actors (lifecycle_state);

CREATE INDEX IF NOT EXISTS actors_agent_liveness_idx
ON actors (kind, lifecycle_state, last_heartbeat_at);
