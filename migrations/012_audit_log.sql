-- The audit log (#30): who did what, in which workspace, and how it went.
--
-- Nothing recorded it. A denied request, a deleted source, a query run from
-- the explore page or a dashboard chat left at most a log line, and log lines
-- are rotated away. This is the history that cannot be backfilled: an audit
-- log added later is empty for exactly the window someone wants to look at.
--
-- One row per event, written by `audit()` in src/lib/audit.ts and nowhere
-- else. What a row may carry:
--
--  * `actor_sub` is the validated identity's subject (or, for a back-channel
--    logout, the subject the realm's signed logout token named). Never a value
--    taken from a request body.
--  * `workspace_id` is the workspace the action was authorized in, derived
--    from the trusted resource. NULL for events that belong to no workspace:
--    a sign-in or a sign-out.
--  * `detail` has been through the log's redaction pass before it gets here:
--    credential shapes are scrubbed, SQL and prompt text is reduced to a
--    digest, and a key that could hold result rows is dropped. No credential
--    and no metric value reaches this column.
--
-- APPEND-ONLY. The trigger below refuses UPDATE, DELETE and TRUNCATE for every
-- role, the table's owner and a superuser included. Grants alone cannot do
-- that here: the app and the migrations connect as the same role, which owns
-- the table, and an owner can always grant itself back what was revoked. An
-- operator who runs the app as its own non-owner role should still grant it
-- only SELECT and INSERT on this table, so the trigger is a second wall rather
-- than the only one. Pruning old rows is a deliberate maintenance step, not
-- something the app can do; docs/.../operations/audit-log.md has the recipe.
--
-- No foreign keys, for the same reason generation_log has none: a row that
-- outlives the dashboard or source it names is the point.

CREATE TABLE IF NOT EXISTS audit_log (
  -- Insertion order, and the keyset the reader pages by.
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  workspace_id   TEXT,
  actor_sub      TEXT NOT NULL,
  -- `user` is a signed-in person (demo visitors included); `realm` is the
  -- identity provider ending sessions over the back channel.
  actor_kind     TEXT NOT NULL CHECK (actor_kind IN ('user', 'realm')),
  -- `dashboard.update`, `source.delete`, `authz.denied`, …: the list lives in
  -- AUDIT_ACTIONS (src/lib/audit.ts). Not a CHECK, so a new event is a code
  -- change rather than a migration.
  action         TEXT NOT NULL,
  resource_type  TEXT,
  resource_id    TEXT,
  outcome        TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
  -- The request that produced the row, matching the `requestId` on its log
  -- lines and on the response a user can quote.
  request_id     TEXT,
  detail         JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Every read is "these workspaces, newest first", paged by id.
CREATE INDEX IF NOT EXISTS audit_log_workspace_idx
  ON audit_log (workspace_id, id DESC);

CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_no_change ON audit_log;
CREATE TRIGGER audit_log_no_change
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();

-- rollback:
-- Nothing reads a row except /api/audit, and the app runs identically without
-- the table: `audit()` logs a failed write and carries on. Dropping it loses
-- the recorded history and nothing else. DROP TABLE is not a DELETE, so the
-- triggers do not stand in its way.
DROP TABLE IF EXISTS audit_log;
DROP FUNCTION IF EXISTS audit_log_append_only();
