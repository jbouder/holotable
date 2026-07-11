import { query, withTransaction } from "@/lib/db/pg";
import {
  SourceConfig,
  type SourceRecord,
} from "@/lib/registry";
import { type Dashboard, parseDashboard } from "@/lib/ir";

/* -------------------------------------------------------------------------- */
/* Source registry repository                                                 */
/* -------------------------------------------------------------------------- */

type SourceRow = {
  id: string;
  workspace_id: string;
  name: string;
  kind: string;
  config: unknown;
  secret_ref: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  tombstoned_at: string | null;
}

function mapSource(row: SourceRow): SourceRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    kind: row.kind,
    config: SourceConfig.parse(row.config),
    secretRef: row.secret_ref,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tombstonedAt: row.tombstoned_at,
  };
}

export async function listSources(
  workspaceId: string,
  opts: { includeTombstoned?: boolean } = {},
): Promise<SourceRecord[]> {
  const rows = await query<SourceRow>(
    `SELECT * FROM sources
     WHERE workspace_id = $1 ${opts.includeTombstoned ? "" : "AND tombstoned_at IS NULL"}
     ORDER BY name`,
    [workspaceId],
  );
  return rows.map(mapSource);
}

/** Fetch a source by id WITHOUT workspace scoping (for authorization lookups). */
export async function getSourceById(id: string): Promise<SourceRecord | null> {
  const rows = await query<SourceRow>(`SELECT * FROM sources WHERE id = $1`, [id]);
  return rows[0] ? mapSource(rows[0]) : null;
}

export async function createSource(input: {
  id: string;
  workspaceId: string;
  name: string;
  kind?: string;
  config: SourceConfig;
  secretRef: string;
  createdBy: string;
}): Promise<SourceRecord> {
  const rows = await query<SourceRow>(
    `INSERT INTO sources (id, workspace_id, name, kind, config, secret_ref, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [
      input.id,
      input.workspaceId,
      input.name,
      input.kind ?? "clickhouse",
      JSON.stringify(input.config),
      input.secretRef,
      input.createdBy,
    ],
  );
  return mapSource(rows[0]);
}

export async function updateSource(
  workspaceId: string,
  id: string,
  patch: { name?: string; config?: SourceConfig; secretRef?: string },
): Promise<SourceRecord | null> {
  const rows = await query<SourceRow>(
    `UPDATE sources
     SET name = COALESCE($3, name),
         config = COALESCE($4, config),
         secret_ref = COALESCE($5, secret_ref),
         updated_at = now()
     WHERE id = $1 AND workspace_id = $2 AND tombstoned_at IS NULL
     RETURNING *`,
    [
      id,
      workspaceId,
      patch.name ?? null,
      patch.config ? JSON.stringify(patch.config) : null,
      patch.secretRef ?? null,
    ],
  );
  return rows[0] ? mapSource(rows[0]) : null;
}

/** Is this source referenced by any stored dashboard version spec? */
export async function isSourceReferenced(id: string): Promise<boolean> {
  const rows = await query<{ referenced: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM dashboard_versions dv,
       jsonb_array_elements(dv.spec->'panels') AS panel
       WHERE panel->'query'->>'sourceId' = $1
     ) AS referenced`,
    [id],
  );
  return rows[0]?.referenced ?? false;
}

/**
 * Delete a source. Referenced sources are tombstoned (never hard-deleted) so
 * that dashboards referencing them keep resolving to a tombstone marker.
 */
export async function deleteSource(
  workspaceId: string,
  id: string,
): Promise<"deleted" | "tombstoned" | "not_found"> {
  if (await isSourceReferenced(id)) {
    const rows = await query<SourceRow>(
      `UPDATE sources SET tombstoned_at = now(), updated_at = now()
       WHERE id = $1 AND workspace_id = $2 AND tombstoned_at IS NULL RETURNING id`,
      [id, workspaceId],
    );
    return rows[0] ? "tombstoned" : "not_found";
  }
  const rows = await query<{ id: string }>(
    `DELETE FROM sources WHERE id = $1 AND workspace_id = $2 RETURNING id`,
    [id, workspaceId],
  );
  return rows[0] ? "deleted" : "not_found";
}

/* -------------------------------------------------------------------------- */
/* Dashboard repository                                                       */
/* -------------------------------------------------------------------------- */

export interface DashboardSummary {
  id: string;
  workspaceId: string;
  title: string;
  createdBy: string;
  version: number;
  updatedAt: string;
}

export interface DashboardRecord extends DashboardSummary {
  spec: Dashboard;
}

type DashboardJoinRow = {
  id: string;
  workspace_id: string;
  title: string;
  created_by: string;
  updated_at: string;
  version: number | null;
  spec: unknown;
}

export async function listDashboards(
  workspaceId: string,
): Promise<DashboardSummary[]> {
  const rows = await query<DashboardJoinRow>(
    `SELECT d.id, d.workspace_id, d.title, d.created_by, d.updated_at, dv.version
     FROM dashboards d
     LEFT JOIN dashboard_versions dv ON dv.id = d.current_version_id
     WHERE d.workspace_id = $1 AND d.deleted_at IS NULL
     ORDER BY d.updated_at DESC`,
    [workspaceId],
  );
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    title: r.title,
    createdBy: r.created_by,
    version: r.version ?? 0,
    updatedAt: r.updated_at,
  }));
}

/** Fetch a dashboard with its current spec (no workspace scoping for authz). */
export async function getDashboardById(
  id: string,
): Promise<DashboardRecord | null> {
  const rows = await query<DashboardJoinRow>(
    `SELECT d.id, d.workspace_id, d.title, d.created_by, d.updated_at,
            dv.version, dv.spec
     FROM dashboards d
     LEFT JOIN dashboard_versions dv ON dv.id = d.current_version_id
     WHERE d.id = $1 AND d.deleted_at IS NULL`,
    [id],
  );
  const r = rows[0];
  if (!r || r.spec == null) return null;
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    title: r.title,
    createdBy: r.created_by,
    version: r.version ?? 0,
    updatedAt: r.updated_at,
    spec: parseDashboard(r.spec),
  };
}

export async function createDashboard(input: {
  workspaceId: string;
  createdBy: string;
  spec: Dashboard;
}): Promise<DashboardRecord> {
  const spec = parseDashboard(input.spec);
  return withTransaction(async (client) => {
    const d = await client.query<{ id: string; created_at: string }>(
      `INSERT INTO dashboards (workspace_id, title, created_by)
       VALUES ($1,$2,$3) RETURNING id, created_at`,
      [input.workspaceId, spec.title, input.createdBy],
    );
    const dashboardId = d.rows[0].id;
    const v = await client.query<{ id: string; created_at: string }>(
      `INSERT INTO dashboard_versions (dashboard_id, version, spec, created_by)
       VALUES ($1, 1, $2, $3) RETURNING id, created_at`,
      [dashboardId, JSON.stringify(spec), input.createdBy],
    );
    await client.query(
      `UPDATE dashboards SET current_version_id = $2, updated_at = now() WHERE id = $1`,
      [dashboardId, v.rows[0].id],
    );
    return {
      id: dashboardId,
      workspaceId: input.workspaceId,
      title: spec.title,
      createdBy: input.createdBy,
      version: 1,
      updatedAt: v.rows[0].created_at,
      spec,
    };
  });
}

/**
 * Save a new immutable version of an existing dashboard. Existing versions are
 * never mutated; a new dashboard_versions row is written and becomes current.
 */
export async function saveDashboardVersion(input: {
  dashboardId: string;
  createdBy: string;
  spec: Dashboard;
}): Promise<DashboardRecord> {
  const spec = parseDashboard(input.spec);
  return withTransaction(async (client) => {
    const cur = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next
       FROM dashboard_versions WHERE dashboard_id = $1`,
      [input.dashboardId],
    );
    const version = cur.rows[0].next;
    const v = await client.query<{ id: string; created_at: string }>(
      `INSERT INTO dashboard_versions (dashboard_id, version, spec, created_by)
       VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [input.dashboardId, version, JSON.stringify(spec), input.createdBy],
    );
    const d = await client.query<{ workspace_id: string; created_by: string }>(
      `UPDATE dashboards
       SET current_version_id = $2, title = $3, updated_at = now()
       WHERE id = $1 RETURNING workspace_id, created_by`,
      [input.dashboardId, v.rows[0].id, spec.title],
    );
    return {
      id: input.dashboardId,
      workspaceId: d.rows[0].workspace_id,
      title: spec.title,
      createdBy: d.rows[0].created_by,
      version,
      updatedAt: v.rows[0].created_at,
      spec,
    };
  });
}

export async function softDeleteDashboard(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE dashboards SET deleted_at = now(), updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
    [id],
  );
  return rows.length > 0;
}
