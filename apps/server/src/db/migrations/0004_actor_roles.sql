-- 0004_actor_roles.sql
--
-- Internal actor roles are a Sprino-only authorization primitive. They do
-- NOT change the Tessera wire shape; they only prepare server-side policy
-- enforcement for later packets in phase A.
--
-- Compatibility:
-- - Additive only: existing API payloads stay unchanged.
-- - Existing rows backfill to a deterministic role ('admin') so pre-A2
--   behavior remains permissive until service-level guards land.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'actor_role'
  ) THEN
    CREATE TYPE actor_role AS ENUM ('admin', 'member');
  END IF;
END
$$;

ALTER TABLE actors
ADD COLUMN IF NOT EXISTS role actor_role;

UPDATE actors
SET role = 'admin'
WHERE role IS NULL;

ALTER TABLE actors
ALTER COLUMN role SET DEFAULT 'admin';

ALTER TABLE actors
ALTER COLUMN role SET NOT NULL;
