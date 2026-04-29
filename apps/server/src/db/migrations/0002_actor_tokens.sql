-- Sprino v0.0.9 — actor lifecycle (Tessera v0.1.2)
-- Adds source provenance to actors and a dedicated actor_tokens table.
--
--   actors.source           — 'env' for boot-imported entries, 'db' for
--                             actor.register-minted entries. env-source
--                             actors are immutable from the API; their
--                             credentials live in the .env file.
--
--   actor_tokens            — sha256(plaintext) only. Plaintext is shown
--                             exactly once on actor.register / rotate_token
--                             and never recovered. Rows are never deleted —
--                             revoke flips revoked_at to preserve audit.
--
--   actor_tokens_active_idx — partial unique on (actor_id) WHERE revoked_at
--                             IS NULL. Hard guarantee: at most one active
--                             credential per actor at any time, including
--                             across concurrent rotate_token calls.

ALTER TABLE "actors" ADD COLUMN "source" text NOT NULL DEFAULT 'db';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "actor_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"source" text NOT NULL DEFAULT 'db',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "actor_tokens_token_hash_unique" UNIQUE("token_hash")
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "actor_tokens" ADD CONSTRAINT "actor_tokens_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "actor_tokens_actor_idx" ON "actor_tokens" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "actor_tokens_token_hash_idx" ON "actor_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "actor_tokens_active_actor_idx" ON "actor_tokens" ("actor_id") WHERE "revoked_at" IS NULL;
