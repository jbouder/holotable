-- Read-only share links (#65): a token that views one dashboard, for a wall
-- display, someone outside the workspace, or an embed in another tool.
--
-- The token itself is never stored. It is signed (src/lib/auth/share.ts) and
-- its SHA-256 is kept here; every use loads this row by id and refuses a token
-- whose hash differs, a share that is revoked or expired, or one for another
-- dashboard. Revoking is setting `revoked_at`, which takes effect on the next
-- request and closes the share's open streams.
--
-- No foreign key to dashboards: a deleted dashboard's shares must keep
-- refusing (the dashboard lookup fails), not vanish with it.

CREATE TABLE IF NOT EXISTS dashboard_shares (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id    UUID NOT NULL,
  workspace_id    TEXT NOT NULL,
  token_hash      TEXT NOT NULL UNIQUE,
  label           TEXT CHECK (label IS NULL OR char_length(label) <= 100),
  -- Origins that may frame the embed; empty means it cannot be framed.
  allowed_origins TEXT[] NOT NULL DEFAULT '{}',
  -- A fixed window `{from, to}` of IR time expressions, or NULL for the
  -- dashboard's own. Resolved by the server like any other (invariant 8).
  time_range      JSONB,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  last_used_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS dashboard_shares_dashboard_idx
  ON dashboard_shares (dashboard_id);

-- rollback:
-- Every share link stops working, which is what removing the feature means;
-- the dashboards themselves are untouched.
DROP TABLE IF EXISTS dashboard_shares;
