-- LLM rate limits and token budgets (#18).
--
-- Neither table holds metrics data, prompts, or model output: only counters
-- and per-workspace ceilings.

-- ---------------------------------------------------------------------------
-- Token usage per workspace and UTC day, split by route and model so the
-- /metrics counters (#51) can label by both. One row per
-- (workspace, day, route, model); each finished model call adds to it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS llm_usage (
  workspace_id  TEXT NOT NULL,
  day           DATE NOT NULL,
  route         TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  requests      BIGINT NOT NULL DEFAULT 0 CHECK (requests >= 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, day, route, model)
);

-- ---------------------------------------------------------------------------
-- Per-workspace overrides of LLM_RATE_PER_MINUTE and LLM_DAILY_TOKEN_BUDGET.
-- A NULL column inherits the global value from the environment; 0 disables
-- that limit for the workspace. There is no UI for this table yet; operators
-- edit it directly.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspace_limits (
  workspace_id       TEXT PRIMARY KEY,
  rate_per_minute    INTEGER CHECK (rate_per_minute >= 0),
  daily_token_budget BIGINT CHECK (daily_token_budget >= 0),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- rollback:
-- Both tables are counters and ceilings, not source data: dropping them loses
-- the current day's usage tallies and any per-workspace overrides, and the
-- limits fall back to the global values from the environment.
DROP TABLE IF EXISTS workspace_limits;
DROP TABLE IF EXISTS llm_usage;
