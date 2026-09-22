-- Catalog freshness on the source registry (#107).
--
-- Two facts about the last introspection, kept on the source row rather than
-- inside `config`: `config` is the SourceConfig its author owns and the
-- browser is shown, and neither of these is part of the allowlist contract.

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS catalog_refreshed_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS catalog_missing_tables TEXT[] NOT NULL DEFAULT '{}';

-- Sources that already exist were configured and vetted before this column
-- did, so they are grandfathered to their last update instead of being
-- reported as never refreshed -- which would block generation against every
-- working source the moment this migration runs.
UPDATE sources
   SET catalog_refreshed_at = updated_at
 WHERE catalog_refreshed_at IS NULL;

-- rollback:
-- Drops the freshness facts only. The catalog itself lives in `config` and is
-- untouched; generation simply stops being gated on how fresh it is.
ALTER TABLE sources
  DROP COLUMN IF EXISTS catalog_missing_tables,
  DROP COLUMN IF EXISTS catalog_refreshed_at;
