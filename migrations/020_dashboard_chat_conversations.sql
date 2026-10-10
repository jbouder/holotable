-- The dashboard chat becomes a conversation (#416, phase 6). Expand only.
--
-- A dashboard's chat is the conversation with that `dashboard_id` and that
-- `user_sub`: at most one per person per dashboard, which the partial index
-- below holds. Every existing `chat_messages` conversation is copied into
-- `conversations` and `conversation_messages` once. `chat_messages` stays, so
-- code from before this migration keeps working during a rolling update;
-- a later migration drops it (phase 7).
--
-- `source_ids` is empty for a dashboard's conversation: its sources are the
-- dashboard's, re-resolved from the dashboard's current spec on every turn.

CREATE UNIQUE INDEX IF NOT EXISTS conversations_dashboard_owner_idx
  ON conversations (user_sub, dashboard_id)
  WHERE dashboard_id IS NOT NULL;

INSERT INTO conversations
  (id, user_sub, workspace_id, source_ids, dashboard_id, title, time_range,
   created_at, updated_at)
SELECT
  gen_random_uuid(),
  m.user_sub,
  d.workspace_id,
  '{}',
  m.dashboard_id,
  -- The first question, clamped to the title's 80 characters, as a new one is.
  left(coalesce((
    SELECT regexp_replace(part->>'text', '\s+', ' ', 'g')
    FROM chat_messages q, jsonb_array_elements(q.content->'parts') part
    WHERE q.dashboard_id = m.dashboard_id AND q.user_sub = m.user_sub
      AND q.role = 'user' AND part->>'type' = 'text'
    ORDER BY q.created_at, q.id
    LIMIT 1
  ), ''), 80),
  coalesce(v.spec->'timeRange', '{"from": "now-1h", "to": "now"}'::jsonb),
  min(m.created_at),
  max(m.created_at)
FROM chat_messages m
JOIN dashboards d ON d.id = m.dashboard_id
LEFT JOIN dashboard_versions v ON v.id = d.current_version_id
GROUP BY m.user_sub, m.dashboard_id, d.workspace_id, v.spec
ON CONFLICT DO NOTHING;

INSERT INTO conversation_messages (conversation_id, id, role, content, created_at)
SELECT c.id, m.id, m.role, m.content, m.created_at
FROM chat_messages m
JOIN conversations c
  ON c.dashboard_id = m.dashboard_id AND c.user_sub = m.user_sub
ORDER BY m.created_at, m.id
ON CONFLICT DO NOTHING;

-- rollback:
-- `chat_messages` still holds every copied row, so going back loses only what
-- the dashboard chat said since; the conversations that continue a dashboard
-- go with the index that made them one per person.
DELETE FROM conversations WHERE dashboard_id IS NOT NULL;
DROP INDEX IF EXISTS conversations_dashboard_owner_idx;
