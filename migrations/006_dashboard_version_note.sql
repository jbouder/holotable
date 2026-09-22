-- A note on a saved dashboard version (#117).
--
-- A `dashboard_versions` row already records who saved it and when, but
-- nothing about WHY -- so a history of a dozen versions reads as a dozen
-- timestamps. The note is the author's own one-line answer, written at save
-- time and surfaced by the version history UI (#73).
--
-- Additive and nullable on purpose: during a rolling update the previous build
-- keeps writing rows without it and reading rows that ignore it, so neither
-- version of the code has to know about the other (expand/contract).

ALTER TABLE dashboard_versions
  ADD COLUMN IF NOT EXISTS note TEXT;

-- rollback:
-- The notes themselves do not survive the rollback, but nothing reads the
-- column except the history UI, and no constraint or index depends on it.
ALTER TABLE dashboard_versions
  DROP COLUMN IF EXISTS note;
