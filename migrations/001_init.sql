-- Holotable config store (PostgreSQL).
--
-- Stores dashboards, immutable dashboard versions, and the source registry.
-- Metrics DATA never lives here; only configuration and validated specs.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Source registry.
--
-- Owns the safe connection config + catalog (table/column allowlist) and a
-- secret_ref. Credentials are NEVER stored here; secret_ref names an env-var
-- family from which the username/password are resolved at execution time.
-- Referenced sources are tombstoned (tombstoned_at set) rather than deleted.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'clickhouse',
  -- Non-secret connection config + catalog allowlist (see lib/db/repo.ts).
  config        JSONB NOT NULL,
  -- Names the env-var family holding credentials, e.g. 'CH_METRICS' resolves
  -- CH_METRICS_USERNAME / CH_METRICS_PASSWORD.
  secret_ref    TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  tombstoned_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sources_workspace_idx ON sources (workspace_id);

-- ---------------------------------------------------------------------------
-- Dashboards. The "live" spec is the latest row in dashboard_versions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dashboards (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       TEXT NOT NULL,
  title              TEXT NOT NULL,
  created_by         TEXT NOT NULL,
  current_version_id UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS dashboards_workspace_idx ON dashboards (workspace_id);

-- ---------------------------------------------------------------------------
-- Immutable dashboard versions. A new row is written on every save; existing
-- rows are never mutated. `spec` is the whole validated IR (jsonb).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dashboard_versions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id UUID NOT NULL REFERENCES dashboards (id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  spec         JSONB NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dashboard_id, version)
);

ALTER TABLE dashboards
  DROP CONSTRAINT IF EXISTS dashboards_current_version_fk;
ALTER TABLE dashboards
  ADD CONSTRAINT dashboards_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES dashboard_versions (id)
  DEFERRABLE INITIALLY DEFERRED;
