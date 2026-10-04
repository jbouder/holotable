-- Renewable sessions (#27).
--
-- A first-party session token is short-lived once the realm hands out a
-- refresh token, and is renewed by `POST /api/auth/refresh` with the refresh
-- token kept here. The browser never sees that token: it holds only an opaque
-- session id, in an httpOnly cookie scoped to /api/auth, and this table stores
-- a SHA-256 of that id rather than the id itself.
--
-- `refresh_token` is AES-256-GCM ciphertext (iv || tag || ciphertext) under a
-- key derived from SESSION_SECRET (src/lib/auth/refresh-token.ts), so a dump
-- of this table is not a way into the realm. Rotating SESSION_SECRET makes
-- every stored token unreadable, which ends every session -- the same thing
-- rotating it already does to the session cookies.
--
-- `oidc_sid` is the realm's own session id (the id_token's `sid` claim), kept
-- for back-channel logout (#28) to find the rows a realm logout ends.
--
-- Rows are deleted on logout, on a refused refresh, and swept once past
-- `expires_at`; nothing else refers to them.

CREATE TABLE IF NOT EXISTS sessions (
  id_hash       TEXT PRIMARY KEY,
  sub           TEXT NOT NULL,
  oidc_sid      TEXT,
  refresh_token BYTEA NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  refreshed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS sessions_oidc_sid_idx ON sessions (oidc_sid);

-- rollback:
-- Every renewable session ends: the next renewal finds no row and the person
-- signs in again, which is what happened at the end of every session before.
DROP TABLE IF EXISTS sessions;
