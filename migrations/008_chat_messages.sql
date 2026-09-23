-- Persistent dashboard chat history (#82).
--
-- The chat was ephemeral React state: it disappeared on reload, so the
-- conversation that worked out why a panel spiked survived exactly as long as
-- the tab did.
--
-- A row is ONE `UIMessage` from the AI SDK, stored whole in `content`. It is
-- not a spec and nothing executes it: the model's SQL reaches the database
-- only through the guarded `runQuery` tool, which re-validates whatever it is
-- handed, so replaying a stored turn cannot run anything. `content` is
-- deliberately opaque JSONB rather than a set of columns -- the message shape
-- is the SDK's, it evolves, and a column per part kind would be a second
-- opinion about it that drifts.
--
-- Scoped per person per dashboard: a chat is a reader working something out,
-- not a shared annotation on the dashboard (annotations are #68). Two people
-- looking at the same dashboard have their own histories and cannot see each
-- other's.

CREATE TABLE IF NOT EXISTS chat_messages (
  -- The AI SDK's own message id. It is what the SDK uses to continue an
  -- assistant message across steps, so reusing it here means re-sending a
  -- turn updates the row it belongs to rather than appending a duplicate.
  id           TEXT NOT NULL,
  dashboard_id UUID NOT NULL REFERENCES dashboards (id) ON DELETE CASCADE,
  user_sub     TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The id is unique per conversation, not globally: the conversation is the
  -- (dashboard, person) pair, and that is also the only way rows are ever read.
  PRIMARY KEY (dashboard_id, user_sub, id)
);

-- Every read is "this person's messages on this dashboard, oldest last", and
-- the retention sweep is "…older than N days". The primary key covers the
-- first two columns; this adds the ordering.
CREATE INDEX IF NOT EXISTS chat_messages_conversation_idx
  ON chat_messages (dashboard_id, user_sub, created_at);

-- rollback:
-- Nothing reads chat history but the chat widget, and the widget already works
-- without it -- that is what it did before this migration. No dashboard, spec,
-- panel or source refers to a row here, so the table goes on its own.
DROP TABLE IF EXISTS chat_messages;
