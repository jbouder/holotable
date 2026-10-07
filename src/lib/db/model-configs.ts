import { query } from "@/lib/db/pg";

/**
 * `workspace_llm_config` and `user_llm_config` rows (#331). The key is the
 * sealed ciphertext, opened only in `src/lib/ai/model-resolution.ts`; the
 * settings are raw JSON, parsed there against `ModelSettings`. The workspace
 * is always the caller's authorized one, from the path or from a trusted
 * record, and the subject is always the verified identity's.
 */

/** One stored configuration. `apiKey` is sealed, or null for none. */
export interface StoredModelConfig {
  provider: string;
  settings: unknown;
  apiKey: Buffer | null;
  updatedBy: string;
  updatedAt: string;
}

export interface WorkspaceModelRecord {
  workspaceId: string;
  /** Null when the workspace uses the environment's model. */
  config: StoredModelConfig | null;
  allowPersonalKeys: boolean;
}

/** What a save writes. `apiKey: "keep"` leaves the stored ciphertext as it is. */
export interface ModelConfigWrite {
  provider: string;
  settings: unknown;
  apiKey: Buffer | null | "keep";
}

export interface ModelConfigStore {
  workspace(workspaceId: string): Promise<WorkspaceModelRecord | null>;
  saveWorkspace(input: {
    workspaceId: string;
    config: ModelConfigWrite | null;
    allowPersonalKeys: boolean;
    updatedBy: string;
  }): Promise<WorkspaceModelRecord>;
  user(sub: string): Promise<StoredModelConfig | null>;
  saveUser(input: { sub: string; config: ModelConfigWrite }): Promise<StoredModelConfig>;
  /** Whether there was one to delete. */
  deleteUser(sub: string): Promise<boolean>;
}

interface WorkspaceRow extends Record<string, unknown> {
  workspace_id: string;
  provider: string | null;
  settings: unknown;
  api_key: Buffer | null;
  allow_personal_keys: boolean;
  updated_by: string;
  updated_at: Date;
}

interface UserRow extends Record<string, unknown> {
  user_sub: string;
  provider: string;
  settings: unknown;
  api_key: Buffer | null;
  updated_at: Date;
}

const iso = (d: Date) => new Date(d).toISOString();

function workspaceRecord(row: WorkspaceRow): WorkspaceModelRecord {
  return {
    workspaceId: row.workspace_id,
    config:
      row.provider === null
        ? null
        : {
            provider: row.provider,
            settings: row.settings,
            apiKey: row.api_key,
            updatedBy: row.updated_by,
            updatedAt: iso(row.updated_at),
          },
    allowPersonalKeys: row.allow_personal_keys,
  };
}

function userRecord(row: UserRow): StoredModelConfig {
  return {
    provider: row.provider,
    settings: row.settings,
    apiKey: row.api_key,
    updatedBy: row.user_sub,
    updatedAt: iso(row.updated_at),
  };
}

const WORKSPACE_COLUMNS =
  "workspace_id, provider, settings, api_key, allow_personal_keys, updated_by, updated_at";

export const pgModelConfigStore: ModelConfigStore = {
  async workspace(workspaceId) {
    const rows = await query<WorkspaceRow>(
      `SELECT ${WORKSPACE_COLUMNS} FROM workspace_llm_config WHERE workspace_id = $1`,
      [workspaceId],
    );
    return rows[0] ? workspaceRecord(rows[0]) : null;
  },

  async saveWorkspace({ workspaceId, config, allowPersonalKeys, updatedBy }) {
    const keep = config?.apiKey === "keep";
    const key = config && config.apiKey !== "keep" ? config.apiKey : null;
    const rows = await query<WorkspaceRow>(
      `INSERT INTO workspace_llm_config AS c
         (workspace_id, provider, settings, api_key, allow_personal_keys, updated_by, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, now())
       ON CONFLICT (workspace_id) DO UPDATE SET
         provider            = EXCLUDED.provider,
         settings            = EXCLUDED.settings,
         api_key             = CASE WHEN $7::boolean AND EXCLUDED.provider IS NOT NULL
                                    THEN c.api_key ELSE EXCLUDED.api_key END,
         allow_personal_keys = EXCLUDED.allow_personal_keys,
         updated_by          = EXCLUDED.updated_by,
         updated_at          = now()
       RETURNING ${WORKSPACE_COLUMNS}`,
      [
        workspaceId,
        config?.provider ?? null,
        config ? JSON.stringify(config.settings) : null,
        key,
        allowPersonalKeys,
        updatedBy,
        keep,
      ],
    );
    return workspaceRecord(rows[0]);
  },

  async user(sub) {
    const rows = await query<UserRow>(
      `SELECT user_sub, provider, settings, api_key, updated_at
         FROM user_llm_config WHERE user_sub = $1`,
      [sub],
    );
    return rows[0] ? userRecord(rows[0]) : null;
  },

  async saveUser({ sub, config }) {
    const keep = config.apiKey === "keep";
    const key = config.apiKey === "keep" ? null : config.apiKey;
    const rows = await query<UserRow>(
      `INSERT INTO user_llm_config AS c (user_sub, provider, settings, api_key, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, now())
       ON CONFLICT (user_sub) DO UPDATE SET
         provider   = EXCLUDED.provider,
         settings   = EXCLUDED.settings,
         api_key    = CASE WHEN $5::boolean THEN c.api_key ELSE EXCLUDED.api_key END,
         updated_at = now()
       RETURNING user_sub, provider, settings, api_key, updated_at`,
      [sub, config.provider, JSON.stringify(config.settings), key, keep],
    );
    return userRecord(rows[0]);
  },

  async deleteUser(sub) {
    const rows = await query<{ user_sub: string }>(
      "DELETE FROM user_llm_config WHERE user_sub = $1 RETURNING user_sub",
      [sub],
    );
    return rows.length > 0;
  },
};
