-- A conversation remembers its model (#437, phase 5, #442). Expand only.
--
-- `model_id` is the catalog id the conversation's turns use: a model's
-- uuid, or `env:<name>` for a server model. NULL until someone picks one,
-- and then each turn resolves as a new one would. Checked in code on every
-- turn, so it has no foreign key: a deleted model is allowed, and the next
-- turn resolves as if none were named.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS model_id TEXT;

-- rollback:
-- Conversations forget their model; every turn resolves the default again.
ALTER TABLE conversations DROP COLUMN IF EXISTS model_id;
