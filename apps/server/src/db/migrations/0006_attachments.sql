-- 0006_attachments.sql
--
-- Attachment storage foundation for Tessera v0.1.4 (C2-P1).
-- Two-phase lifecycle: pending (upload slot reserved) → ready (binary confirmed).
--
-- Design notes:
-- - Additive only: no existing tables change.
-- - attachment.list returns ready attachments where deleted_at IS NULL.
-- - deleted_at enables soft-delete so attachment.get by id survives after "deletion".
-- - storage_key is NULL while pending; set by the service on finalize to the
--   path relative to the storage root. The download url is then served by the
--   upload route, not stored in the DB.
-- - url is set by the service on finalize; NULL while pending.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'attachment_status'
  ) THEN
    CREATE TYPE attachment_status AS ENUM ('pending', 'ready');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS attachments (
  id            uuid                     PRIMARY KEY,
  task_id       uuid                     NOT NULL REFERENCES tasks(id),
  filename      text                     NOT NULL,
  content_type  text                     NOT NULL,
  size_bytes    integer                  NOT NULL CHECK (size_bytes >= 1),
  status        attachment_status        NOT NULL DEFAULT 'pending',
  url           text,
  storage_key   text,
  created_by    uuid                     NOT NULL REFERENCES actors(id),
  created_at    timestamp with time zone NOT NULL DEFAULT now(),
  finalized_at  timestamp with time zone,
  deleted_at    timestamp with time zone
);

CREATE INDEX IF NOT EXISTS attachments_task_idx
  ON attachments (task_id);
