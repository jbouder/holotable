import { query } from "@/lib/db/pg";

/**
 * The model catalog (#439): `llm_models` rows, and each workspace's default
 * and personal-keys toggle on `workspace_llm_config`. Credentials are the
 * sealed ciphertext, opened only in `src/lib/ai/model-resolution.ts`; the
 * settings are raw JSON, parsed there against `ModelSettings`.
 *
 * Every statement is scoped by its owner: the workspace is always the
 * caller's authorized one, from the path or a trusted record, and the
 * subject always the verified identity's. A model id alone reaches nothing.
 */

/** Whose a model is. */
export type ModelOwner =
  | { scope: "workspace"; workspaceId: string }
  | { scope: "personal"; sub: string };

export interface StoredModel {
  id: string;
  scope: "workspace" | "personal";
  workspaceId: string | null;
  userSub: string | null;
  name: string;
  provider: string;
  settings: unknown;
  /** Sealed, or null for none. */
  credentials: Buffer | null;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** What a save writes. `credentials: "keep"` leaves the stored ciphertext as it is. */
export interface ModelWrite {
  name: string;
  provider: string;
  settings: unknown;
  credentials: Buffer | null | "keep";
}

export interface WorkspaceModelSettings {
  workspaceId: string;
  /** A catalog id or `env:<name>`, or null for the server's default. */
  defaultModel: string | null;
  allowPersonalKeys: boolean;
}

/** Another model of this owner already has the name. */
export class DuplicateModelName extends Error {
  override name = "DuplicateModelName";
}

export interface ModelStore {
  list(owner: ModelOwner): Promise<StoredModel[]>;
  get(owner: ModelOwner, id: string): Promise<StoredModel | null>;
  create(owner: ModelOwner, write: ModelWrite, actor: string): Promise<StoredModel>;
  /** Null when the owner has no model with that id. */
  update(
    owner: ModelOwner,
    id: string,
    write: ModelWrite,
    actor: string,
  ): Promise<StoredModel | null>;
  /** Whether there was one to delete. Clears the workspace's default when it was that. */
  delete(owner: ModelOwner, id: string): Promise<boolean>;
  workspace(workspaceId: string): Promise<WorkspaceModelSettings | null>;
  saveWorkspace(
    input: WorkspaceModelSettings & { updatedBy: string },
  ): Promise<WorkspaceModelSettings>;
}

interface ModelRow extends Record<string, unknown> {
  id: string;
  scope: "workspace" | "personal";
  workspace_id: string | null;
  user_sub: string | null;
  name: string;
  provider: string;
  settings: unknown;
  credentials: Buffer | null;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
}

interface WorkspaceRow extends Record<string, unknown> {
  workspace_id: string;
  default_model: string | null;
  allow_personal_keys: boolean;
}

const COLUMNS =
  "id, scope, workspace_id, user_sub, name, provider, settings, credentials, created_by, updated_by, created_at, updated_at";

const iso = (d: Date) => new Date(d).toISOString();

/** PostgreSQL's unique_violation. */
const UNIQUE_VIOLATION = "23505";

/** A uuid, so a malformed id in a path is "no such model", not a cast error. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isModelId(id: string): boolean {
  return UUID.test(id);
}

function model(row: ModelRow): StoredModel {
  return {
    id: row.id,
    scope: row.scope,
    workspaceId: row.workspace_id,
    userSub: row.user_sub,
    name: row.name,
    provider: row.provider,
    settings: row.settings,
    credentials: row.credentials,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** The owner as a WHERE clause over `$1` (scope) and `$2` (workspace or subject). */
function ownerParams(owner: ModelOwner): [string, string] {
  return owner.scope === "workspace"
    ? [owner.scope, owner.workspaceId]
    : [owner.scope, owner.sub];
}

const OWNED =
  "scope = $1 AND (CASE WHEN $1 = 'workspace' THEN workspace_id ELSE user_sub END) = $2";

async function uniquely<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
      throw new DuplicateModelName("another model already has that name");
    }
    throw err;
  }
}

export const pgModelStore: ModelStore = {
  async list(owner) {
    const rows = await query<ModelRow>(
      `SELECT ${COLUMNS} FROM llm_models WHERE ${OWNED} ORDER BY created_at, id`,
      ownerParams(owner),
    );
    return rows.map(model);
  },

  async get(owner, id) {
    if (!isModelId(id)) return null;
    const rows = await query<ModelRow>(
      `SELECT ${COLUMNS} FROM llm_models WHERE ${OWNED} AND id = $3`,
      [...ownerParams(owner), id],
    );
    return rows[0] ? model(rows[0]) : null;
  },

  async create(owner, write, actor) {
    if (write.credentials === "keep") throw new Error("a new model has nothing to keep");
    const credentials = write.credentials;
    const rows = await uniquely(() =>
      query<ModelRow>(
        `INSERT INTO llm_models
           (id, scope, workspace_id, user_sub, name, provider, settings, credentials,
            created_by, updated_by)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $8)
         RETURNING ${COLUMNS}`,
        [
          owner.scope,
          owner.scope === "workspace" ? owner.workspaceId : null,
          owner.scope === "personal" ? owner.sub : null,
          write.name,
          write.provider,
          JSON.stringify(write.settings),
          credentials,
          actor,
        ],
      ),
    );
    return model(rows[0]);
  },

  async update(owner, id, write, actor) {
    if (!isModelId(id)) return null;
    const keep = write.credentials === "keep";
    const rows = await uniquely(() =>
      query<ModelRow>(
        `UPDATE llm_models SET
           name        = $4,
           provider    = $5,
           settings    = $6::jsonb,
           credentials = CASE WHEN $8::boolean THEN credentials ELSE $7 END,
           updated_by  = $9,
           updated_at  = now()
         WHERE ${OWNED} AND id = $3
         RETURNING ${COLUMNS}`,
        [
          ...ownerParams(owner),
          id,
          write.name,
          write.provider,
          JSON.stringify(write.settings),
          keep ? null : write.credentials,
          keep,
          actor,
        ],
      ),
    );
    return rows[0] ? model(rows[0]) : null;
  },

  async delete(owner, id) {
    if (!isModelId(id)) return false;
    const rows = await query<{ id: string }>(
      `WITH gone AS (
         DELETE FROM llm_models WHERE ${OWNED} AND id = $3 RETURNING id, workspace_id
       ), cleared AS (
         UPDATE workspace_llm_config c SET default_model = NULL
         FROM gone WHERE c.workspace_id = gone.workspace_id
           AND c.default_model = gone.id::text
       )
       SELECT id FROM gone`,
      [...ownerParams(owner), id],
    );
    return rows.length > 0;
  },

  async workspace(workspaceId) {
    const rows = await query<WorkspaceRow>(
      `SELECT workspace_id, default_model, allow_personal_keys
         FROM workspace_llm_config WHERE workspace_id = $1`,
      [workspaceId],
    );
    const row = rows[0];
    return row
      ? {
          workspaceId: row.workspace_id,
          defaultModel: row.default_model,
          allowPersonalKeys: row.allow_personal_keys,
        }
      : null;
  },

  async saveWorkspace({ workspaceId, defaultModel, allowPersonalKeys, updatedBy }) {
    // The 017 slot columns are left as they are: code from before #439 still
    // reads them during a rolling update.
    const rows = await query<WorkspaceRow>(
      `INSERT INTO workspace_llm_config AS c
         (workspace_id, default_model, allow_personal_keys, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (workspace_id) DO UPDATE SET
         default_model       = EXCLUDED.default_model,
         allow_personal_keys = EXCLUDED.allow_personal_keys,
         updated_by          = EXCLUDED.updated_by,
         updated_at          = now()
       RETURNING workspace_id, default_model, allow_personal_keys`,
      [workspaceId, defaultModel, allowPersonalKeys, updatedBy],
    );
    const row = rows[0];
    return {
      workspaceId: row.workspace_id,
      defaultModel: row.default_model,
      allowPersonalKeys: row.allow_personal_keys,
    };
  },
};
