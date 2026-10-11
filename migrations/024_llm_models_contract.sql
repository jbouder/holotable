-- The model catalog, contract (#437, phase 7, #444).
--
-- Migration 022 copied each 017 slot into `llm_models` and left the slots in
-- place, so the code from before it kept working during a rolling update
-- (expand). Nothing has read them since: every instance resolves models from
-- the catalog. This drops them (contract): a workspace's `provider`,
-- `settings` and `api_key` columns, and the per-person `user_llm_config`
-- table. `workspace_llm_config` keeps the workspace's default model and its
-- personal-models toggle.

ALTER TABLE workspace_llm_config
  DROP COLUMN IF EXISTS provider,
  DROP COLUMN IF EXISTS settings,
  DROP COLUMN IF EXISTS api_key;

DROP TABLE IF EXISTS user_llm_config;

-- rollback:
-- The slots come back from the catalog: a workspace's default model, when it
-- is one of its own, fills its slot; a person's oldest personal model fills
-- theirs. A workspace whose default is a server model, or a person's later
-- models, have no slot to go back to; they stay in `llm_models`.
--
-- The table is rebuilt rather than altered so its columns and constraints
-- come back in 017's order and with 017's names, which is what the
-- migrations check compares.
CREATE TEMPORARY TABLE workspace_llm_config_keep ON COMMIT DROP AS
SELECT * FROM workspace_llm_config;

DROP TABLE workspace_llm_config;

CREATE TABLE workspace_llm_config (
  workspace_id        TEXT PRIMARY KEY,
  provider            TEXT,
  settings            JSONB CHECK (settings IS NULL OR jsonb_typeof(settings) = 'object'),
  api_key             BYTEA,
  allow_personal_keys BOOLEAN NOT NULL DEFAULT false,
  updated_by          TEXT NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((provider IS NULL) = (settings IS NULL)),
  CHECK (provider IS NOT NULL OR api_key IS NULL)
);
ALTER TABLE workspace_llm_config ADD COLUMN default_model TEXT;

INSERT INTO workspace_llm_config
  (workspace_id, provider, settings, api_key, allow_personal_keys, updated_by,
   updated_at, default_model)
SELECT k.workspace_id, m.provider, m.settings, m.credentials, k.allow_personal_keys,
       k.updated_by, k.updated_at, k.default_model
FROM workspace_llm_config_keep k
LEFT JOIN llm_models m
  ON m.scope = 'workspace' AND m.workspace_id = k.workspace_id
 AND m.id::text = k.default_model;

CREATE TABLE IF NOT EXISTS user_llm_config (
  user_sub   TEXT PRIMARY KEY,
  provider   TEXT NOT NULL,
  settings   JSONB NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  api_key    BYTEA,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO user_llm_config (user_sub, provider, settings, api_key, updated_at)
SELECT DISTINCT ON (user_sub) user_sub, provider, settings, credentials, updated_at
FROM llm_models
WHERE scope = 'personal'
ORDER BY user_sub, created_at, id;
