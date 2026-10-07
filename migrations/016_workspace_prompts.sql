-- Per-workspace prompt customization (#66): the glossary, metric definitions
-- and few-shot example panels a workspace's source-admins add to every
-- dashboard, panel and explore generation in that workspace.
--
-- No credentials and no metrics data: the text is written by an admin, and
-- each example's panel passed the IR and the SQL guard against a source in
-- this workspace before it was saved. One row per workspace; a workspace
-- without one generates from the base prompt alone.

CREATE TABLE IF NOT EXISTS workspace_prompts (
  workspace_id       TEXT PRIMARY KEY,
  glossary           TEXT NOT NULL DEFAULT '',
  metric_definitions JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(metric_definitions) = 'array'),
  examples           JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(examples) = 'array'),
  updated_by         TEXT NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- rollback:
-- Every workspace generates from the base prompt again; nothing else reads
-- the table.
DROP TABLE IF EXISTS workspace_prompts;
