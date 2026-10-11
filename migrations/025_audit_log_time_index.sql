-- Retention and scale (#494): the audit page filters by time.
--
-- `audit_log_workspace_idx` serves "these workspaces, newest first" by id.
-- A window (`from`/`to` on the audit page) filters on `at`, which no index
-- covered, so a narrow window over a long log scanned back through every
-- newer row first. Expand only: nothing reads the index by name, and old
-- code runs unchanged beside it.

CREATE INDEX IF NOT EXISTS audit_log_workspace_at_idx
  ON audit_log (workspace_id, at DESC);

-- rollback:
-- The audit page goes back to scanning by id for a time window: slower on a
-- long log, the same answers.
DROP INDEX IF EXISTS audit_log_workspace_at_idx;
