-- Service-account API tokens (#288): how a pipeline, a script or a CI job
-- calls the API, since only a person can complete an OIDC sign-in.
--
-- A token belongs to one workspace at one role, viewer or editor, never
-- source-admin and never platform admin; the CHECK below holds the role, and
-- `can()` decides every request from it. Only the token's SHA-256 is stored;
-- the plaintext (`ht_…`) is shown once, when it is created. Every request
-- looks the row up again, so a revoked or expired token is refused on its
-- next use. `last_used_at` is what lets an admin spot a token nothing uses.

CREATE TABLE IF NOT EXISTS api_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  name         TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  token_hash   TEXT NOT NULL UNIQUE,
  role         TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS api_tokens_workspace_idx ON api_tokens (workspace_id);

-- rollback:
-- Every token stops working, which is what removing the feature means; nothing
-- else reads the table.
DROP TABLE IF EXISTS api_tokens;
