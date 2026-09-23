-- Per-person preferences that follow someone across devices (#213).
--
-- Until now every preference lived in one browser: a second laptop or a
-- cleared profile silently reset how times are shown and where the app opens.
-- One row per subject holds them as JSONB. The shape is owned by the Zod
-- schema in src/lib/preferences.ts, which reads a row field by field and drops
-- anything it no longer recognises, so a field can be added or retired
-- without a migration. What is deliberately NOT here -- the theme, which must
-- apply before first paint -- is explained next to that schema.
--
-- Keyed by `sub` alone. Preferences are personal, not workspace-scoped, and
-- the only reader and writer is the caller's own session.

CREATE TABLE IF NOT EXISTS user_preferences (
  sub        TEXT PRIMARY KEY,
  prefs      JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(prefs) = 'object'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- rollback:
-- Nothing else refers to a row here, and every reader falls back to the
-- defaults when there is no row, which is what it did before this migration.
-- Dropping it resets everyone's preferences to those defaults.
DROP TABLE IF EXISTS user_preferences;
