ALTER TABLE sources
  ALTER COLUMN kind SET DEFAULT 'timescaledb';

-- rollback:
-- 001 already creates sources.kind with exactly this default, so against a
-- database built from 001 the down step restores the value the up step set and
-- the schema is unchanged either way. It is written out rather than declared
-- irreversible so the down path is real and CI exercises it.
ALTER TABLE sources
  ALTER COLUMN kind SET DEFAULT 'timescaledb';
