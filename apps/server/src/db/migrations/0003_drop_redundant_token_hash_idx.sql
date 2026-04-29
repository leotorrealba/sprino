-- 0003_drop_redundant_token_hash_idx.sql
--
-- Remove the redundant `actor_tokens_token_hash_idx` btree index. The
-- `token_hash` column already has a UNIQUE constraint
-- (`actor_tokens_token_hash_unique`), and Postgres backs every UNIQUE
-- constraint with its own btree index. Carrying a second, non-unique
-- index on the same column doubles write amplification on every token
-- mint/revoke for zero read benefit.
--
-- Safe to apply: dropping a non-unique index never blocks queries
-- (the unique constraint's backing index continues to serve lookups
-- on token_hash, and that's the index the auth path actually uses).

DROP INDEX IF EXISTS "actor_tokens_token_hash_idx";
