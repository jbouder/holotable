-- Chat conversations (#416).
--
-- A conversation is one person asking questions of a few sources in one
-- workspace. It is personal, like `user_preferences`: every read and write is
-- keyed on `user_sub` from the session, and no route reads another person's.
--
-- Nothing here is authorization. `source_ids` are opaque ids re-resolved and
-- re-authorized on every turn and every panel run; `workspace_id` is derived
-- from the trusted source records when the conversation is made, never taken
-- from a request.

CREATE TABLE IF NOT EXISTS conversations (
  id            UUID PRIMARY KEY,
  user_sub      TEXT NOT NULL,
  workspace_id  TEXT NOT NULL,
  source_ids    TEXT[] NOT NULL,
  -- Set when the conversation continues a dashboard's chat (#416, phase 6).
  dashboard_id  UUID REFERENCES dashboards (id) ON DELETE SET NULL,
  -- Derived from the first question, never a model call. Empty until then.
  title         TEXT NOT NULL DEFAULT '',
  -- An IR TimeRange, resolved by the server on every run.
  time_range    JSONB NOT NULL,
  -- The variable picks carried over from a dashboard, already checked.
  variables     JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The history list: "this person's, most recently used first".
CREATE INDEX IF NOT EXISTS conversations_owner_idx
  ON conversations (user_sub, updated_at DESC, id DESC);

-- A row is ONE `UIMessage`, as `chat_messages` holds one. A drawn panel's
-- result rows are never in it: `persistableMessage` reduces every `showPanel`
-- output to its spec, row count and a few sample rows before it is written.
CREATE TABLE IF NOT EXISTS conversation_messages (
  conversation_id UUID NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  -- The AI SDK's own message id, so a re-sent message updates its row.
  id              TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content         JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Insertion order. A turn's question and answer are written in one
  -- transaction and share `created_at`; this keeps them in the order they
  -- were said, and a message that grows keeps its place.
  seq             BIGINT GENERATED ALWAYS AS IDENTITY,
  PRIMARY KEY (conversation_id, id)
);

CREATE INDEX IF NOT EXISTS conversation_messages_order_idx
  ON conversation_messages (conversation_id, seq);

-- Every `showPanel` spec a chat turn writes is a generation (#416).
ALTER TABLE generation_log DROP CONSTRAINT IF EXISTS generation_log_mode_check;
ALTER TABLE generation_log ADD CONSTRAINT generation_log_mode_check
  CHECK (mode IN ('dashboard', 'dashboard-refine', 'panel', 'explore',
                  'source-draft', 'chat'));

-- rollback:
-- Conversations are personal history and nothing else refers to them; the
-- tables go whole. The log's rows from chat turns go with the mode they name,
-- since the narrower CHECK would refuse them.
DELETE FROM generation_log WHERE mode = 'chat';
ALTER TABLE generation_log DROP CONSTRAINT IF EXISTS generation_log_mode_check;
ALTER TABLE generation_log ADD CONSTRAINT generation_log_mode_check
  CHECK (mode IN ('dashboard', 'dashboard-refine', 'panel', 'explore',
                  'source-draft'));
DROP TABLE IF EXISTS conversation_messages;
DROP TABLE IF EXISTS conversations;
