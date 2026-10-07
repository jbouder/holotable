-- In-app model configuration (#331): a workspace's model, a person's own
-- model, and which of the two (or the environment) each generation used.
--
-- A generation resolves its model per request: the caller's personal row
-- when they have one AND their workspace's `allow_personal_keys` is on, then
-- the workspace's configuration, then the environment (AI_PROVIDER, AI_MODEL,
-- ...), which is what every generation used before this migration.
--
-- `provider` names the provider and `settings` holds its own fields (for
-- `openai-compatible`: baseUrl, model, api) as validated by `ModelSettings` in
-- src/lib/ai/model-config.ts. There is deliberately no CHECK on `provider`:
-- adding a native provider is a new member of that schema, not a migration.
--
-- `api_key` is AES-256-GCM ciphertext (iv || tag || ciphertext) under a key
-- derived from SESSION_SECRET with its own label (src/lib/secrets/seal.ts),
-- the same arrangement as `sessions.refresh_token`. No route returns it.
-- Rotating SESSION_SECRET makes every stored key unreadable: the settings
-- pages then ask for the key again, and generation in that workspace says so
-- instead of failing on a provider's 401. NULL means no key, for an endpoint
-- that needs none.

CREATE TABLE IF NOT EXISTS workspace_llm_config (
  workspace_id        TEXT PRIMARY KEY,
  -- NULL together: the workspace uses the environment's model, and the row
  -- exists only to carry `allow_personal_keys`.
  provider            TEXT,
  settings            JSONB CHECK (settings IS NULL OR jsonb_typeof(settings) = 'object'),
  api_key             BYTEA,
  allow_personal_keys BOOLEAN NOT NULL DEFAULT false,
  updated_by          TEXT NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((provider IS NULL) = (settings IS NULL)),
  CHECK (provider IS NOT NULL OR api_key IS NULL)
);

-- One per person, keyed by the realm subject. It applies only in a workspace
-- whose row allows personal keys, and is ignored everywhere else.
CREATE TABLE IF NOT EXISTS user_llm_config (
  user_sub   TEXT PRIMARY KEY,
  provider   TEXT NOT NULL,
  settings   JSONB NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  api_key    BYTEA,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which level answered, so cost and behavior stay attributable. NULL on rows
-- written before this migration, which all used the environment.
ALTER TABLE generation_log
  ADD COLUMN IF NOT EXISTS model_config TEXT
    CHECK (model_config IN ('personal', 'workspace', 'environment'));

-- rollback:
-- Every generation uses the environment's model again, as it did before; the
-- stored keys are gone with their tables, and the log forgets which level
-- each row used.
ALTER TABLE generation_log DROP COLUMN IF EXISTS model_config;
DROP TABLE IF EXISTS user_llm_config;
DROP TABLE IF EXISTS workspace_llm_config;
