-- The model catalog (#437, phase 2, #439). Expand only.
--
-- Until now a workspace had one model slot (`workspace_llm_config`) and a
-- person one (`user_llm_config`), both from migration 017. A model is now a
-- named entry in `llm_models`, any number per workspace (scope `workspace`,
-- added by a source-admin) or per person (scope `personal`). Server models
-- come from the environment and are never stored; their ids are `env:<name>`.
--
-- `provider` names a provider kind from `src/lib/ai/providers/registry.ts`
-- and `settings` holds that kind's fields, validated in code; there is
-- deliberately no CHECK on `provider`, as 017 decided. `credentials` is
-- AES-256-GCM ciphertext under a key derived from SESSION_SECRET with its
-- own label (a bare API key, or a JSON object of the kind's fields), the same
-- arrangement as 017's `api_key`; NULL means none. No route returns it.
--
-- `workspace_llm_config.default_model` is what a generation in the workspace
-- uses when nobody picks: a catalog id, or `env:<name>` for a server model.
-- It is checked in code, so it has no foreign key; deleting the default
-- model clears it.
--
-- Each configured slot is copied once: a workspace's becomes a workspace
-- model named "Workspace model" and the workspace's default, a person's a
-- personal model named "Personal model". The 017 columns and table stay,
-- so code from before this migration keeps working during a rolling update;
-- a later migration drops them (phase 7).

CREATE TABLE IF NOT EXISTS llm_models (
  id           UUID PRIMARY KEY,
  scope        TEXT NOT NULL CHECK (scope IN ('workspace', 'personal')),
  -- The owning workspace, for scope = 'workspace'.
  workspace_id TEXT,
  -- The owner, a realm subject, for scope = 'personal'.
  user_sub     TEXT,
  -- What people see; unique within its owner, ignoring case.
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  provider     TEXT NOT NULL,
  settings     JSONB NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  credentials  BYTEA,
  created_by   TEXT NOT NULL,
  updated_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((scope = 'workspace') = (workspace_id IS NOT NULL)),
  CHECK ((scope = 'personal') = (user_sub IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS llm_models_workspace_name
  ON llm_models (workspace_id, lower(name)) WHERE scope = 'workspace';
CREATE UNIQUE INDEX IF NOT EXISTS llm_models_user_name
  ON llm_models (user_sub, lower(name)) WHERE scope = 'personal';

ALTER TABLE workspace_llm_config ADD COLUMN IF NOT EXISTS default_model TEXT;

-- The data move. A workspace's slot keeps its id across the two statements
-- through a temporary table, so the default can name it.
CREATE TEMPORARY TABLE llm_models_moved ON COMMIT DROP AS
SELECT gen_random_uuid() AS id, c.*
FROM workspace_llm_config c
WHERE c.provider IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM llm_models m
    WHERE m.scope = 'workspace' AND m.workspace_id = c.workspace_id
  );

INSERT INTO llm_models
  (id, scope, workspace_id, name, provider, settings, credentials,
   created_by, updated_by, created_at, updated_at)
SELECT id, 'workspace', workspace_id, 'Workspace model', provider, settings, api_key,
       updated_by, updated_by, updated_at, updated_at
FROM llm_models_moved;

UPDATE workspace_llm_config c
SET default_model = m.id::text
FROM llm_models_moved m
WHERE c.workspace_id = m.workspace_id AND c.default_model IS NULL;

INSERT INTO llm_models
  (id, scope, user_sub, name, provider, settings, credentials,
   created_by, updated_by, created_at, updated_at)
SELECT gen_random_uuid(), 'personal', u.user_sub, 'Personal model', u.provider,
       u.settings, u.api_key, u.user_sub, u.user_sub, u.updated_at, u.updated_at
FROM user_llm_config u
WHERE NOT EXISTS (
  SELECT 1 FROM llm_models m WHERE m.scope = 'personal' AND m.user_sub = u.user_sub
);

-- rollback:
-- The 017 slots still hold what was copied, so going back loses only the
-- models added since, and each workspace's choice of default.
ALTER TABLE workspace_llm_config DROP COLUMN IF EXISTS default_model;
DROP TABLE IF EXISTS llm_models;
