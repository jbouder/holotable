-- Dashboard metadata and organization (#119, #80).
--
-- A dashboard row carried an identity and nothing else, so a list of them read
-- as a wall of titles: no way to say what one is for, no way to say that four
-- of them belong to one service, and no way to keep the three you actually
-- open near the top.
--
-- All three columns here are *workspace metadata about* a dashboard, not part
-- of the spec IR. That distinction is the point: the spec is the contract
-- between generation, execution and rendering, and a description nobody
-- executes has no business forcing a `specVersion` bump (#58) or riding along
-- in an export. `title` stays where it already was -- in the spec, mirrored
-- onto the row by `saveDashboardVersion` -- so renaming still appends a
-- version and the two can never disagree.
--
-- Additive and defaulted, so a rolling update is safe in both directions: the
-- previous build writes rows without these columns and reads rows that ignore
-- them (expand/contract).

ALTER TABLE dashboards
  ADD COLUMN IF NOT EXISTS description TEXT;

-- `NOT NULL DEFAULT '{}'` rather than a nullable array: every read path then
-- gets a list to iterate instead of a null to remember, and "no tags" has one
-- representation rather than two.
ALTER TABLE dashboards
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

-- The list filters with `tags @> $1` (contains-all), which is what a GIN index
-- on an array answers directly.
CREATE INDEX IF NOT EXISTS dashboards_tags_idx ON dashboards USING GIN (tags);

-- ---------------------------------------------------------------------------
-- Favourites are per person, not per workspace: they say which dashboards THIS
-- reader keeps coming back to, so they key on the identity's subject and live
-- outside the dashboard row that everyone shares.
--
-- `ON DELETE CASCADE` is right here and wrong for a source: a favourite of a
-- deleted dashboard is not a dangling reference someone has to resolve, it is
-- a bookmark to nothing. (A soft-deleted dashboard keeps its favourites, since
-- the row is still there.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dashboard_favorites (
  user_sub     TEXT NOT NULL,
  dashboard_id UUID NOT NULL REFERENCES dashboards (id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_sub, dashboard_id)
);

-- The primary key already covers "this person's favourites"; this covers the
-- other direction, which is what the cascade walks on delete.
CREATE INDEX IF NOT EXISTS dashboard_favorites_dashboard_idx
  ON dashboard_favorites (dashboard_id);

-- rollback:
-- The metadata itself does not survive the rollback. Nothing executes it:
-- panels, queries and the poller read the spec, which is untouched, so a
-- dashboard that loses its tags still renders exactly as it did.
DROP TABLE IF EXISTS dashboard_favorites;
DROP INDEX IF EXISTS dashboards_tags_idx;
ALTER TABLE dashboards
  DROP COLUMN IF EXISTS tags;
ALTER TABLE dashboards
  DROP COLUMN IF EXISTS description;
