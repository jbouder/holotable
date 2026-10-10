-- The dashboard chat's old table goes (#416, phase 7). Contract only.
--
-- Migration 020 copied every row into `conversations` and
-- `conversation_messages`, and from then on the dashboard chat read and
-- wrote those; nothing reads this table. It is dropped one release after,
-- so a rolling update never had code running against a missing table.

DROP TABLE IF EXISTS chat_messages;

-- rollback:
-- The table comes back as 008 made it, refilled from the conversations that
-- continue a dashboard's chat, so code from before 020 finds what it wrote
-- and what was said since.
CREATE TABLE IF NOT EXISTS chat_messages (
  id           TEXT NOT NULL,
  dashboard_id UUID NOT NULL REFERENCES dashboards (id) ON DELETE CASCADE,
  user_sub     TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (dashboard_id, user_sub, id)
);
CREATE INDEX IF NOT EXISTS chat_messages_conversation_idx
  ON chat_messages (dashboard_id, user_sub, created_at);
INSERT INTO chat_messages (id, dashboard_id, user_sub, role, content, created_at)
SELECT m.id, c.dashboard_id, c.user_sub, m.role, m.content, m.created_at
FROM conversation_messages m
JOIN conversations c ON c.id = m.conversation_id
WHERE c.dashboard_id IS NOT NULL
ON CONFLICT DO NOTHING;
