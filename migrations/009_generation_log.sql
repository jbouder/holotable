-- Redacted prompt/spec pairs for every model generation (#23).
--
-- Nothing recorded what was asked of the model or what came back. When a
-- generated dashboard is wrong the only artefact is the result someone is
-- complaining about -- not the prompt, not which catalog was in context, not
-- the raw spec. This table is that record, and the raw material for the eval
-- corpus (#24).
--
-- Three properties make it safe to keep:
--
--  * The prompt is stored REDACTED. It is free text a person typed, and people
--    paste connection strings into free text. `redactPrompt` in
--    src/lib/ai/log.ts runs before the insert; a credential shape never
--    reaches this column.
--  * The catalog is stored as a HASH, not as text. What was in context is a
--    question of "the same catalog as that other run?", which a digest answers;
--    the column names and host-shaped strings inside the rendered catalog are
--    not worth keeping to answer it.
--  * `spec` is a validated IR spec, which by construction carries opaque source
--    ids and no connection detail -- the same invariant that holds for a
--    dashboard version holds here. Nothing executes a row: the specs stored
--    here are a record, and a spec that is ever run again goes back through the
--    SQL guard like any other.
--
-- It is a LOG, not a resource: rows are never joined onto a dashboard and are
-- read only by a workspace source-admin (or a platform admin) through
-- /api/generation-log. Retention is enforced on write -- see
-- GENERATION_LOG_RETENTION_DAYS -- so the table stays bounded without a
-- scheduled job, the same arrangement chat_messages uses.

CREATE TABLE IF NOT EXISTS generation_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Derived from the trusted source record (or, for a source draft, from the
  -- workspace the caller was already authorized in). Never from a request body.
  workspace_id     TEXT NOT NULL,
  created_by       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Which author action produced the call. The four /api/generate modes plus
  -- the source drafter, which has no source yet and so no catalog.
  mode             TEXT NOT NULL CHECK (
                     mode IN ('dashboard', 'dashboard-refine', 'panel',
                              'explore', 'source-draft')
                   ),
  -- No foreign key on purpose: a log entry outliving the source it names is
  -- the normal case (a source is tombstoned, the log still says what was
  -- generated against it), and ON DELETE CASCADE would erase exactly the
  -- history someone is looking for.
  source_id        TEXT,
  prompt_redacted  TEXT NOT NULL,
  catalog_hash     TEXT,
  -- The validated spec the model returned, or NULL when the run failed.
  spec             JSONB,
  model            TEXT NOT NULL,
  -- Model calls per author action. The generation paths run the model exactly
  -- once, so this is 1 today; it is a column rather than an assumption so a
  -- future repair/retry loop has somewhere to say otherwise.
  attempts         INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  input_tokens     INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens    INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  -- Redacted failure message when the run produced no spec.
  error            TEXT
);

-- Every read is "this workspace's generations, newest first", and the
-- retention sweep is "...older than N days" within a workspace.
CREATE INDEX IF NOT EXISTS generation_log_workspace_idx
  ON generation_log (workspace_id, created_at DESC);

-- rollback:
-- The log is write-mostly and nothing depends on a row: no dashboard, spec,
-- panel or source refers to one, and the app generates identically without the
-- table -- that is what it did before this migration. Dropping it loses the
-- recorded history and nothing else.
DROP TABLE IF EXISTS generation_log;
