import { query, withTransaction } from "@/lib/db/pg";
import { log } from "@/lib/log";
import { SourceConfig, type SourceRecord } from "@/lib/registry";
import { type Dashboard, parseDashboard } from "@/lib/ir";
import type { BudgetStore } from "@/lib/limits/budget";
import type { WorkspaceLimits } from "@/lib/limits/llm";
import type { ImpactDashboard, SourceImpact } from "@/lib/source-impact";
import { type Template, TemplateBody, TemplateKind } from "@/lib/templates";

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
  catalog_refreshed_at: string | null;
  catalog_missing_tables: string[] | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  tombstoned_at: string | null;
};

function mapSource(row: SourceRow): SourceRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    kind: row.kind,
    config: SourceConfig.parse(row.config),
    secretRef: row.secret_ref,
    catalogRefreshedAt: row.catalog_refreshed_at,
    catalogMissingTables: row.catalog_missing_tables ?? [],
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
      input.kind ?? "timescaledb",
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
  patch: {
    name?: string;
    config?: SourceConfig;
    secretRef?: string;
    /** Set together by the refresh route; a null column leaves both alone. */
    catalogRefreshedAt?: Date;
    catalogMissingTables?: string[];
  },
): Promise<SourceRecord | null> {
  const rows = await query<SourceRow>(
    `UPDATE sources
     SET name = COALESCE($3, name),
         config = COALESCE($4, config),
         secret_ref = COALESCE($5, secret_ref),
         catalog_refreshed_at = COALESCE($6::timestamptz, catalog_refreshed_at),
         catalog_missing_tables = COALESCE($7::text[], catalog_missing_tables),
         updated_at = now()
     WHERE id = $1 AND workspace_id = $2 AND tombstoned_at IS NULL
     RETURNING *`,
    [
      id,
      workspaceId,
      patch.name ?? null,
      patch.config ? JSON.stringify(patch.config) : null,
      patch.secretRef ?? null,
      patch.catalogRefreshedAt ?? null,
      patch.catalogMissingTables ?? null,
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
 * Which dashboards and panels currently point at this source.
 *
 * Deliberately narrower than {@link isSourceReferenced}: that one looks at
 * EVERY stored version, because a source named by any version must keep
 * resolving to a tombstone rather than vanish, while impact answers "what
 * stops working if this goes away" — and that is the *current* version of each
 * live dashboard. A source referenced only by superseded history is reported
 * as having no impact and is still tombstoned rather than deleted.
 *
 * Scoped to `workspaceId`, which the caller takes from the source record
 * itself, so the result can never describe a dashboard in another workspace.
 */
export async function sourceImpact(
  workspaceId: string,
  sourceId: string,
): Promise<SourceImpact> {
  const rows = await query<{
    dashboard_id: string;
    dashboard_title: string;
    panel_id: string | null;
    panel_title: string | null;
  }>(
    `SELECT d.id AS dashboard_id, d.title AS dashboard_title,
            panel->>'id' AS panel_id, panel->>'title' AS panel_title
     FROM dashboards d
     JOIN dashboard_versions dv ON dv.id = d.current_version_id
     CROSS JOIN LATERAL jsonb_array_elements(dv.spec->'panels')
       WITH ORDINALITY AS t(panel, ord)
     WHERE d.workspace_id = $1
       AND d.deleted_at IS NULL
       AND panel->'query'->>'sourceId' = $2
     ORDER BY d.title, d.id, t.ord`,
    [workspaceId, sourceId],
  );

  const dashboards: ImpactDashboard[] = [];
  for (const row of rows) {
    let dashboard = dashboards.find((d) => d.id === row.dashboard_id);
    if (!dashboard) {
      dashboard = { id: row.dashboard_id, title: row.dashboard_title, panels: [] };
      dashboards.push(dashboard);
    }
    dashboard.panels.push({
      id: row.panel_id ?? "",
      title: row.panel_title ?? row.panel_id ?? "",
    });
  }
  return {
    sourceId,
    dashboards,
    // The tombstone decision looks wider than the impact list does, so the
    // confirmation can say which of the two outcomes a delete will produce.
    referencedByAnyVersion: await isSourceReferenced(sourceId),
  };
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
};

export async function listDashboards(workspaceId: string): Promise<DashboardSummary[]> {
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
export async function getDashboardById(id: string): Promise<DashboardRecord | null> {
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

/* -------------------------------------------------------------------------- */
/* LLM limits and usage (#18)                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Per-workspace overrides of the global LLM ceilings, or `null` when the
 * workspace has no `workspace_limits` row. A `null` column inherits the
 * environment value; `0` disables that limit for the workspace.
 */
export async function getWorkspaceLimits(
  workspaceId: string,
): Promise<WorkspaceLimits | null> {
  const rows = await query<{
    rate_per_minute: number | null;
    daily_token_budget: string | null;
  }>(
    "SELECT rate_per_minute, daily_token_budget FROM workspace_limits WHERE workspace_id = $1",
    [workspaceId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    ratePerMinute: row.rate_per_minute,
    // BIGINT arrives as a string from pg.
    dailyTokenBudget:
      row.daily_token_budget === null ? null : Number(row.daily_token_budget),
  };
}

/** The `llm_usage` table as a {@link BudgetStore}. */
export const pgBudgetStore: BudgetStore = {
  async tokensUsed(workspaceId, day) {
    const rows = await query<{ used: string }>(
      `SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::text AS used
         FROM llm_usage
        WHERE workspace_id = $1 AND day = $2`,
      [workspaceId, day],
    );
    return Number(rows[0]?.used ?? 0);
  },
  async record(delta) {
    await query(
      `INSERT INTO llm_usage (workspace_id, day, route, model, input_tokens, output_tokens, requests)
       VALUES ($1, $2, $3, $4, $5, $6, 1)
       ON CONFLICT (workspace_id, day, route, model) DO UPDATE SET
         input_tokens  = llm_usage.input_tokens  + EXCLUDED.input_tokens,
         output_tokens = llm_usage.output_tokens + EXCLUDED.output_tokens,
         requests      = llm_usage.requests + 1,
         updated_at    = now()`,
      [
        delta.workspaceId,
        delta.day,
        delta.route,
        delta.model,
        delta.inputTokens,
        delta.outputTokens,
      ],
    );
  },
};

/* -------------------------------------------------------------------------- */
/* Template repository (#120)                                                 */
/* -------------------------------------------------------------------------- */

type TemplateRow = {
  id: string;
  workspace_id: string;
  kind: string;
  name: string;
  description: string | null;
  body: unknown;
  created_by: string;
  created_at: string;
};

/**
 * A stored row as the picker's {@link Template}.
 *
 * `body` is parsed against the IR on the way out as well as on the way in: a
 * row written before an IR change is exactly the case where a template would
 * otherwise be applied as a shape nothing else in the system accepts.
 */
function mapTemplate(row: TemplateRow): Template {
  return {
    id: row.id,
    origin: "workspace",
    kind: TemplateKind.parse(row.kind),
    name: row.name,
    description: row.description ?? undefined,
    body: TemplateBody.parse(row.body),
    workspaceId: row.workspace_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/**
 * The templates saved in a workspace, newest name-ordered so the picker reads
 * the same way twice. A row whose stored body no longer parses against the IR
 * is dropped rather than failing the whole list: one unreadable template must
 * not take the other five down with it.
 */
export async function listTemplates(
  workspaceId: string,
  kind?: TemplateKind,
): Promise<Template[]> {
  const rows = await query<TemplateRow>(
    `SELECT * FROM templates
      WHERE workspace_id = $1 AND ($2::text IS NULL OR kind = $2)
      ORDER BY kind, name`,
    [workspaceId, kind ?? null],
  );
  return rows.flatMap((row) => {
    try {
      return [mapTemplate(row)];
    } catch {
      log.warn("template.unreadable", { templateId: row.id });
      return [];
    }
  });
}

/** Fetch a template WITHOUT workspace scoping (for authorization lookups). */
export async function getTemplateById(id: string): Promise<Template | null> {
  const rows = await query<TemplateRow>(`SELECT * FROM templates WHERE id = $1`, [id]);
  return rows[0] ? mapTemplate(rows[0]) : null;
}

/** Raised when the workspace already has a template of this kind and name. */
export class DuplicateTemplateName extends Error {}

/** PostgreSQL's unique_violation. */
const UNIQUE_VIOLATION = "23505";

export async function createTemplate(input: {
  workspaceId: string;
  name: string;
  description?: string;
  body: TemplateBody;
  createdBy: string;
}): Promise<Template> {
  const body = TemplateBody.parse(input.body);
  try {
    const rows = await query<TemplateRow>(
      `INSERT INTO templates (workspace_id, kind, name, description, body, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [
        input.workspaceId,
        body.kind,
        input.name,
        input.description ?? null,
        JSON.stringify(body),
        input.createdBy,
      ],
    );
    return mapTemplate(rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
      throw new DuplicateTemplateName(input.name);
    }
    throw err;
  }
}

/**
 * Delete a template. Hard, unlike a source or a dashboard: nothing references
 * a template after it has been applied — instantiation copies the spec — so
 * there is no dangling reference a tombstone would protect.
 */
export async function deleteTemplate(workspaceId: string, id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `DELETE FROM templates WHERE id = $1 AND workspace_id = $2 RETURNING id`,
    [id, workspaceId],
  );
  return rows.length > 0;
}
