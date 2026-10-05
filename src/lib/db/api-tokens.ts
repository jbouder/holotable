import type { RunQuery } from "@/lib/db/annotations";
import { query } from "@/lib/db/pg";

/** A service-account token's row (#288). Never the token. */
export interface ApiTokenRecord {
  id: string;
  workspaceId: string;
  name: string;
  tokenHash: string;
  role: "viewer" | "editor";
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface ApiTokenStore {
  /** The row a token's hash names, whatever its state. */
  byHash(tokenHash: string): Promise<ApiTokenRecord | null>;
  /** A workspace's tokens, newest first, revoked ones included. */
  list(workspaceId: string): Promise<ApiTokenRecord[]>;
  create(
    input: Omit<ApiTokenRecord, "id" | "createdAt" | "revokedAt" | "lastUsedAt">,
  ): Promise<ApiTokenRecord>;
  /** Whether a live token of that workspace was revoked. */
  revoke(input: { id: string; workspaceId: string }): Promise<boolean>;
  /** Record a use, at most once a minute. */
  touch(id: string): Promise<void>;
}

interface Row extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  name: string;
  token_hash: string;
  role: "viewer" | "editor";
  created_by: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

function toRecord(row: Row): ApiTokenRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    tokenHash: row.token_hash,
    role: row.role,
    createdBy: row.created_by,
    createdAt: iso(row.created_at) ?? "",
    expiresAt: iso(row.expires_at) ?? "",
    revokedAt: iso(row.revoked_at),
    lastUsedAt: iso(row.last_used_at),
  };
}

const COLUMNS =
  "id, workspace_id, name, token_hash, role, created_by, created_at, expires_at, revoked_at, last_used_at";

export function makeApiTokenStore(run: RunQuery): ApiTokenStore {
  return {
    async byHash(tokenHash) {
      const [row] = await run<Row>(
        `SELECT ${COLUMNS} FROM api_tokens WHERE token_hash = $1`,
        [tokenHash],
      );
      return row ? toRecord(row) : null;
    },
    async list(workspaceId) {
      const rows = await run<Row>(
        `SELECT ${COLUMNS} FROM api_tokens WHERE workspace_id = $1
         ORDER BY created_at DESC LIMIT 200`,
        [workspaceId],
      );
      return rows.map(toRecord);
    },
    async create(input) {
      const [row] = await run<Row>(
        `INSERT INTO api_tokens (workspace_id, name, token_hash, role, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${COLUMNS}`,
        [
          input.workspaceId,
          input.name,
          input.tokenHash,
          input.role,
          input.createdBy,
          input.expiresAt,
        ],
      );
      return toRecord(row);
    },
    async revoke({ id, workspaceId }) {
      const rows = await run<{ id: string }>(
        `UPDATE api_tokens SET revoked_at = now()
         WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL
         RETURNING id`,
        [id, workspaceId],
      );
      return rows.length > 0;
    },
    async touch(id) {
      await run(
        `UPDATE api_tokens SET last_used_at = now()
         WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
        [id],
      );
    },
  };
}

export const pgApiTokenStore: ApiTokenStore = makeApiTokenStore(query);
