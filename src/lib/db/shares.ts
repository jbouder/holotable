import { query } from "@/lib/db/pg";
import type { RunQuery } from "@/lib/db/annotations";
import { TimeRange } from "@/lib/ir";

/** One share link, as its row holds it (#65). Never the token. */
export interface ShareRecord {
  id: string;
  dashboardId: string;
  workspaceId: string;
  tokenHash: string;
  label: string | null;
  allowedOrigins: string[];
  timeRange: TimeRange | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface ShareStore {
  get(id: string): Promise<ShareRecord | null>;
  /** The dashboard's shares, newest first, revoked ones included. */
  list(input: { dashboardId: string; workspaceId: string }): Promise<ShareRecord[]>;
  create(
    input: Omit<ShareRecord, "createdAt" | "revokedAt" | "lastUsedAt">,
  ): Promise<ShareRecord>;
  /** Whether a live share of that dashboard was revoked. */
  revoke(input: {
    id: string;
    dashboardId: string;
    workspaceId: string;
  }): Promise<boolean>;
  /** Record a use, at most once a minute. */
  touch(id: string): Promise<void>;
}

interface Row extends Record<string, unknown> {
  id: string;
  dashboard_id: string;
  workspace_id: string;
  token_hash: string;
  label: string | null;
  allowed_origins: string[];
  time_range: unknown;
  created_by: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

function toRecord(row: Row): ShareRecord {
  const range = TimeRange.safeParse(row.time_range);
  return {
    id: row.id,
    dashboardId: row.dashboard_id,
    workspaceId: row.workspace_id,
    tokenHash: row.token_hash,
    label: row.label,
    allowedOrigins: row.allowed_origins ?? [],
    timeRange: range.success ? range.data : null,
    createdBy: row.created_by,
    createdAt: iso(row.created_at) ?? "",
    expiresAt: iso(row.expires_at) ?? "",
    revokedAt: iso(row.revoked_at),
    lastUsedAt: iso(row.last_used_at),
  };
}

const COLUMNS = `id, dashboard_id, workspace_id, token_hash, label, allowed_origins,
  time_range, created_by, created_at, expires_at, revoked_at, last_used_at`;

export function makeShareStore(run: RunQuery): ShareStore {
  return {
    async get(id) {
      const [row] = await run<Row>(
        `SELECT ${COLUMNS} FROM dashboard_shares WHERE id = $1`,
        [id],
      );
      return row ? toRecord(row) : null;
    },
    async list({ dashboardId, workspaceId }) {
      const rows = await run<Row>(
        `SELECT ${COLUMNS} FROM dashboard_shares
         WHERE dashboard_id = $1 AND workspace_id = $2
         ORDER BY created_at DESC LIMIT 100`,
        [dashboardId, workspaceId],
      );
      return rows.map(toRecord);
    },
    async create(input) {
      const [row] = await run<Row>(
        `INSERT INTO dashboard_shares
           (id, dashboard_id, workspace_id, token_hash, label, allowed_origins,
            time_range, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${COLUMNS}`,
        [
          input.id,
          input.dashboardId,
          input.workspaceId,
          input.tokenHash,
          input.label,
          input.allowedOrigins,
          input.timeRange ? JSON.stringify(input.timeRange) : null,
          input.createdBy,
          input.expiresAt,
        ],
      );
      return toRecord(row);
    },
    async revoke({ id, dashboardId, workspaceId }) {
      const rows = await run<{ id: string }>(
        `UPDATE dashboard_shares SET revoked_at = now()
         WHERE id = $1 AND dashboard_id = $2 AND workspace_id = $3 AND revoked_at IS NULL
         RETURNING id`,
        [id, dashboardId, workspaceId],
      );
      return rows.length > 0;
    },
    async touch(id) {
      await run(
        `UPDATE dashboard_shares SET last_used_at = now()
         WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
        [id],
      );
    },
  };
}

export const pgShareStore: ShareStore = makeShareStore(query);
