-- Annotations (#68): the deploy that happened at 14:02, the incident that was
-- open from 14:05 to 14:40, drawn on the time-series panels of every dashboard
-- in the workspace so a spike can be read against what caused it.
--
-- Workspace-scoped: a row belongs to exactly one workspace, every read names
-- that workspace from a trusted record (a dashboard's own, or the path of the
-- workspace being written), and no query reads across workspaces.
--
-- `at` and `ended_at` are instants written by a person or a pipeline. They are
-- display data and never reach a statement the guard runs; they never set a
-- panel's window either, which stays the server's (invariant 8).

CREATE TABLE IF NOT EXISTS annotations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  at           TIMESTAMPTZ NOT NULL,
  -- A range when set: an incident, a maintenance window. A point otherwise.
  ended_at     TIMESTAMPTZ CHECK (ended_at IS NULL OR ended_at >= at),
  kind         TEXT NOT NULL CHECK (kind IN ('deploy', 'incident', 'note')),
  title        TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description  TEXT CHECK (description IS NULL OR char_length(description) <= 2000),
  tags         TEXT[] NOT NULL DEFAULT '{}',
  -- The validated identity's subject that wrote it.
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Where it came from: `manual` from the dashboard, or a pipeline's name.
  source       TEXT NOT NULL DEFAULT 'manual' CHECK (char_length(source) BETWEEN 1 AND 64)
);

-- Every read is "this workspace, in this window".
CREATE INDEX IF NOT EXISTS annotations_workspace_at_idx ON annotations (workspace_id, at);

-- rollback:
-- Annotations are context drawn over charts; nothing else reads them, and the
-- dashboards render without the table. Dropping it loses the markers written.
DROP TABLE IF EXISTS annotations;
