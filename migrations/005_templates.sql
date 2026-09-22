-- Panel and dashboard templates (#120).
--
-- A template is a reusable SPEC: a `Panel` or a `Dashboard` out of the shared
-- IR, stored whole in `body` and validated against that IR on the way in and
-- on the way out. It is not a new kind of dashboard and it is not data -- the
-- same invariants that hold for a dashboard version hold here, which is why
-- the body carries no connection detail and no credential, only the opaque
-- source ids the IR already allows.

CREATE TABLE IF NOT EXISTS templates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  -- Which half of the IR `body` holds. Mirrored from the body's own tag by the
  -- constraint below, so the column can be indexed and filtered on without
  -- becoming a second, drifting opinion about what the row contains.
  kind         TEXT NOT NULL CHECK (kind IN ('panel', 'dashboard')),
  name         TEXT NOT NULL,
  description  TEXT,
  body         JSONB NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT templates_kind_matches_body CHECK (kind = body->>'kind'),
  -- Templates are picked from a list by name, so two rows that read
  -- identically in that list are a usability bug rather than a feature. The
  -- API turns the violation into a 409 that names the clash.
  CONSTRAINT templates_name_unique UNIQUE (workspace_id, kind, name)
);

CREATE INDEX IF NOT EXISTS templates_workspace_idx
  ON templates (workspace_id, kind, name);

-- rollback:
-- Nothing references templates, so the table goes on its own. Dashboards
-- created from a template are ordinary dashboards and are untouched: the
-- instantiation copies the spec rather than pointing at the row.
DROP TABLE IF EXISTS templates;
