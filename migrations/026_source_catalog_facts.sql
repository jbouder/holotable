-- What the server is, as introspection found it (#557). Expand only.
--
-- A TimescaleDB source may be plain PostgreSQL: it connects and tests the
-- same, but `time_bucket` does not exist there, so the model must be told
-- which it is. That is a fact about the server, not part of the allowlist
-- its author owns, so it sits beside `config` like `catalog_refreshed_at`
-- and `catalog_missing_tables`. Its shape is the source kind's (for
-- TimescaleDB, `{"timescaledb": "2.17.2"}` or `{"timescaledb": null}`) and is
-- checked in code. **Test** and an applied **Refresh** write it; nothing a
-- browser sends does. NULL (never tested since this migration) keeps the
-- behavior from before it, and old code ignores the column.

ALTER TABLE sources ADD COLUMN IF NOT EXISTS catalog_facts JSONB
  CHECK (catalog_facts IS NULL OR jsonb_typeof(catalog_facts) = 'object');

-- rollback:
-- The next Test or Refresh after re-applying writes the facts again; until
-- then every source is treated as never tested, which is today's behavior.
ALTER TABLE sources DROP COLUMN IF EXISTS catalog_facts;
