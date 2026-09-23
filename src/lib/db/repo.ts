import { query, withTransaction } from "@/lib/db/pg";
import { type DashboardSort, PAGE_SIZE } from "@/lib/dashboard-list";
import {
  type DashboardRecord,
  type DashboardSummary,
  escapeLike,
  normalizeTags,
} from "@/lib/dashboard-metadata";
import { log } from "@/lib/log";
import { SourceConfig, type SourceRecord } from "@/lib/registry";
import { type Dashboard, parseDashboard } from "@/lib/ir";
import type { BudgetStore } from "@/lib/limits/budget";
import type { WorkspaceLimits } from "@/lib/limits/llm";
import type { ImpactDashboard, SourceImpact } from "@/lib/source-impact";
import type { StoredChatMessage } from "@/lib/chat-history";
import type { GenerationLogEntry, GenerationLogRow } from "@/lib/ai/log";
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

// The row shapes live in `@/lib/dashboard-metadata` so the list UI can name
// them without importing `pg`; re-exported here because this is where every
// caller already reaches for them.
export type { DashboardRecord, DashboardSummary };

type DashboardJoinRow = {
  id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  tags: string[] | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  version: number | null;
  favorite: boolean | null;
  spec: unknown;
};

function mapSummary(row: DashboardJoinRow): DashboardSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    description: row.description,
    tags: row.tags ?? [],
    createdBy: row.created_by,
    version: row.version ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    favorite: row.favorite ?? false,
  };
}

/** What the list page and `GET /api/dashboards` may narrow the list by. */
export interface DashboardListOptions {
  /** Free text over title and description. */
  search?: string;
  /** ANDed: a dashboard must carry every one of them. */
  tags?: string[];
  sort?: DashboardSort;
  limit?: number;
  offset?: number;
  /**
   * Whose favourites to resolve. Favouriting is per person, so without a
   * subject every row comes back `favorite: false` — which is the right answer
   * for a caller that has no identity in hand rather than a reason to fail.
   */
  userSub?: string;
  /** Only rows `userSub` has starred. Requires `userSub`. */
  favoritesOnly?: boolean;
  /**
   * Only these ids, in addition to every other filter. This is how the
   * recently-viewed strip resolves the ids a browser kept: the workspace scope
   * and the caller's authorization still decide what comes back, so an id from
   * storage can name a row but never reach one.
   */
  ids?: string[];
}

/**
 * Dashboard ids are `gen_random_uuid()` primary keys, and `ids` reaches this
 * function from a browser's `localStorage` — so a value that is not a UUID is
 * filtered out here rather than handed to `$n::uuid[]`, where it would fail the
 * whole query instead of simply matching nothing.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `sort` → the ORDER BY it selects. Fixed strings; never interpolated input. */
const DASHBOARD_ORDER: Record<DashboardSort, string> = {
  updated: "d.updated_at DESC, d.id",
  created: "d.created_at DESC, d.id",
  title: "lower(d.title) ASC, d.id",
};

/**
 * One page of the dashboards in a workspace, with the total the filters match.
 *
 * The filtering, ordering and paging all happen in SQL rather than over a full
 * list in memory: the list is the page a workspace with three hundred
 * dashboards lands on, and `ORDER BY updated_at DESC` over all of them to show
 * twenty-four is the shape that stops working first.
 *
 * `total` rides along on the same query as a window count, so the pager cannot
 * disagree with the rows above it.
 */
export async function listDashboards(
  workspaceId: string,
  opts: DashboardListOptions = {},
): Promise<{ dashboards: DashboardSummary[]; total: number }> {
  const search = opts.search?.trim() ? `%${escapeLike(opts.search.trim())}%` : null;
  const tags = opts.tags?.length ? opts.tags : null;
  const order = DASHBOARD_ORDER[opts.sort ?? "updated"];
  // An `ids` filter that survives normalization to nothing must stay a filter
  // that matches nothing, not fall back to "every dashboard".
  const ids = opts.ids ? opts.ids.filter((id) => UUID.test(id)) : null;

  const rows = await query<DashboardJoinRow & { total: string }>(
    `SELECT d.id, d.workspace_id, d.title, d.description, d.tags,
            d.created_by, d.created_at, d.updated_at,
            dv.version,
            (f.dashboard_id IS NOT NULL) AS favorite,
            COUNT(*) OVER () AS total
     FROM dashboards d
     LEFT JOIN dashboard_versions dv ON dv.id = d.current_version_id
     LEFT JOIN dashboard_favorites f
       ON f.dashboard_id = d.id AND f.user_sub = $2::text
     WHERE d.workspace_id = $1 AND d.deleted_at IS NULL
       AND ($3::text IS NULL
            OR d.title ILIKE $3 ESCAPE '\\'
            OR d.description ILIKE $3 ESCAPE '\\')
       AND ($4::text[] IS NULL OR d.tags @> $4)
       AND ($5::boolean IS NOT TRUE OR f.dashboard_id IS NOT NULL)
       AND ($6::uuid[] IS NULL OR d.id = ANY($6))
     ORDER BY ${order}
     LIMIT $7 OFFSET $8`,
    [
      workspaceId,
      opts.userSub ?? null,
      search,
      tags,
      opts.favoritesOnly ?? false,
      ids,
      opts.limit ?? PAGE_SIZE,
      opts.offset ?? 0,
    ],
  );

  return {
    dashboards: rows.map(mapSummary),
    // `COUNT(*) OVER ()` is a bigint, and a page past the end has no rows to
    // carry it — which is itself the answer only when nothing matched.
    total: rows[0] ? Number(rows[0].total) : 0,
  };
}

/**
 * Every tag in use in a workspace, with how many dashboards carry it.
 *
 * This is the filter bar's vocabulary, and it is derived rather than stored:
 * there is no tag registry to keep in step, so a tag stops existing exactly
 * when the last dashboard wearing it stops wearing it.
 */
export async function listDashboardTags(
  workspaceId: string,
): Promise<{ tag: string; count: number }[]> {
  const rows = await query<{ tag: string; count: string }>(
    `SELECT tag, COUNT(*)::text AS count
     FROM dashboards d, unnest(d.tags) AS tag
     WHERE d.workspace_id = $1 AND d.deleted_at IS NULL
     GROUP BY tag
     ORDER BY COUNT(*) DESC, tag ASC`,
    [workspaceId],
  );
  return rows.map((r) => ({ tag: r.tag, count: Number(r.count) }));
}

/**
 * Write a dashboard's description and tags.
 *
 * Workspace-scoped in the statement itself, not just at the route: a dashboard
 * id is the only thing a caller supplies, and the `WHERE` is what makes an id
 * from another workspace a miss rather than a write. No version is appended —
 * these columns are not in the spec, which is the whole reason they are
 * columns (see `src/lib/dashboard-metadata.ts`).
 */
export async function updateDashboardMetadata(
  workspaceId: string,
  id: string,
  patch: { description?: string | null; tags?: string[] },
): Promise<DashboardSummary | null> {
  const rows = await query<DashboardJoinRow>(
    `UPDATE dashboards d
        SET description = CASE WHEN $3::boolean THEN $4::text ELSE d.description END,
            tags        = COALESCE($5::text[], d.tags),
            updated_at  = now()
      WHERE d.id = $1 AND d.workspace_id = $2 AND d.deleted_at IS NULL
      RETURNING d.id, d.workspace_id, d.title, d.description, d.tags,
                d.created_by, d.created_at, d.updated_at,
                (SELECT version FROM dashboard_versions
                  WHERE id = d.current_version_id) AS version,
                FALSE AS favorite`,
    [
      id,
      workspaceId,
      // `description` is nullable, so "clear it" and "leave it alone" cannot
      // both be expressed by a null parameter; the boolean says which was meant.
      patch.description !== undefined,
      patch.description ?? null,
      // Normalized here as well as at the API boundary, so the column's
      // invariant — folded, deduplicated, sorted — is a property of the table
      // rather than of one route remembering to hold it.
      patch.tags ? normalizeTags(patch.tags) : null,
    ],
  );
  return rows[0] ? mapSummary(rows[0]) : null;
}

/** Star or unstar a dashboard for one person. Idempotent in both directions. */
export async function setDashboardFavorite(
  userSub: string,
  dashboardId: string,
  favorite: boolean,
): Promise<void> {
  if (favorite) {
    await query(
      `INSERT INTO dashboard_favorites (user_sub, dashboard_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userSub, dashboardId],
    );
    return;
  }
  await query(
    `DELETE FROM dashboard_favorites WHERE user_sub = $1 AND dashboard_id = $2`,
    [userSub, dashboardId],
  );
}

/**
 * Fetch a dashboard with its current spec (no workspace scoping for authz).
 *
 * `favorite` is false here rather than resolved: this is the record the viewer
 * and the editor read, and whether the reader starred it is the list's
 * question, asked once for a page of rows instead of once per dashboard.
 */
export async function getDashboardById(id: string): Promise<DashboardRecord | null> {
  const rows = await query<DashboardJoinRow>(
    `SELECT d.id, d.workspace_id, d.title, d.description, d.tags,
            d.created_by, d.created_at, d.updated_at,
            FALSE AS favorite,
            dv.version, dv.spec
     FROM dashboards d
     LEFT JOIN dashboard_versions dv ON dv.id = d.current_version_id
     WHERE d.id = $1 AND d.deleted_at IS NULL`,
    [id],
  );
  const r = rows[0];
  if (!r || r.spec == null) return null;
  return { ...mapSummary(r), spec: parseDashboard(r.spec) };
}

export async function createDashboard(input: {
  workspaceId: string;
  createdBy: string;
  spec: Dashboard;
  /** Row metadata to write alongside version 1 (a duplicate carries it over). */
  description?: string | null;
  tags?: string[];
}): Promise<DashboardRecord> {
  const spec = parseDashboard(input.spec);
  const tags = normalizeTags(input.tags ?? []);
  return withTransaction(async (client) => {
    const d = await client.query<{ id: string; created_at: string }>(
      `INSERT INTO dashboards (workspace_id, title, created_by, description, tags)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [input.workspaceId, spec.title, input.createdBy, input.description ?? null, tags],
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
      description: input.description ?? null,
      tags,
      createdBy: input.createdBy,
      version: 1,
      createdAt: d.rows[0].created_at,
      updatedAt: v.rows[0].created_at,
      favorite: false,
      spec,
    };
  });
}

/**
 * Save a new immutable version of an existing dashboard. Existing versions are
 * never mutated; a new dashboard_versions row is written and becomes current.
 *
 * The `title` column is written from `spec.title` on every save — the spec is
 * the authority for the name (`TITLE_AUTHORITY` in `dashboard-metadata.ts`),
 * which is why a rename goes through here rather than updating the row.
 */
export async function saveDashboardVersion(input: {
  dashboardId: string;
  createdBy: string;
  spec: Dashboard;
  /** The author's one-line "what changed", or null when they wrote none. */
  note?: string | null;
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
      `INSERT INTO dashboard_versions (dashboard_id, version, spec, created_by, note)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [
        input.dashboardId,
        version,
        JSON.stringify(spec),
        input.createdBy,
        input.note ?? null,
      ],
    );
    const d = await client.query<{
      workspace_id: string;
      created_by: string;
      created_at: string;
      description: string | null;
      tags: string[] | null;
    }>(
      `UPDATE dashboards
       SET current_version_id = $2, title = $3, updated_at = now()
       WHERE id = $1
       RETURNING workspace_id, created_by, created_at, description, tags`,
      [input.dashboardId, v.rows[0].id, spec.title],
    );
    return {
      id: input.dashboardId,
      workspaceId: d.rows[0].workspace_id,
      title: spec.title,
      description: d.rows[0].description,
      tags: d.rows[0].tags ?? [],
      createdBy: d.rows[0].created_by,
      version,
      createdAt: d.rows[0].created_at,
      updatedAt: v.rows[0].created_at,
      favorite: false,
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
/* Generation log (#23)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Write one generation and sweep what fell out of retention.
 *
 * The sweep runs in the same statement batch as the insert, which is what
 * keeps the table bounded without a scheduled job: the only way a row is added
 * is the only way rows are removed. `0` days disables the age check and lets
 * the log grow, which is the right default for nobody and an option for an
 * operator who ships rows elsewhere.
 *
 * Every value here has already been through `generationRow`; this function
 * does no redaction of its own on purpose, so there is exactly one place to
 * read to know what reaches the column.
 */
export async function insertGenerationLog(
  row: GenerationLogRow,
  retentionDays: number,
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO generation_log
         (workspace_id, created_by, mode, source_id, prompt_redacted,
          catalog_hash, spec, model, attempts, input_tokens, output_tokens, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)`,
      [
        row.workspaceId,
        row.createdBy,
        row.mode,
        row.sourceId,
        row.promptRedacted,
        row.catalogHash,
        row.spec === null ? null : JSON.stringify(row.spec),
        row.model,
        row.attempts,
        row.inputTokens,
        row.outputTokens,
        row.error,
      ],
    );
    if (retentionDays > 0) {
      await client.query(
        `DELETE FROM generation_log
          WHERE workspace_id = $1
            AND created_at <= now() - make_interval(days => $2)`,
        [row.workspaceId, retentionDays],
      );
    }
  });
}

type GenerationLogEntryRow = {
  id: string;
  workspace_id: string;
  created_by: string;
  created_at: string;
  mode: string;
  source_id: string | null;
  prompt_redacted: string;
  catalog_hash: string | null;
  spec: unknown;
  model: string;
  attempts: number;
  input_tokens: number;
  output_tokens: number;
  error: string | null;
};

/**
 * The most recent generations in the given workspaces, newest first.
 *
 * The caller passes workspaces it has already decided the identity may read --
 * `authorizedWorkspaces(identity, "source:manage", …)` -- so an empty list
 * here means an empty answer rather than an unscoped one. The age filter is
 * applied on read as well as on write, so shortening the retention window
 * hides rows immediately instead of whenever the next generation happens.
 */
export async function listGenerationLog(
  workspaceIds: string[],
  opts: { limit: number; retentionDays: number },
): Promise<GenerationLogEntry[]> {
  if (workspaceIds.length === 0) return [];
  const rows = await query<GenerationLogEntryRow>(
    `SELECT id, workspace_id, created_by, created_at, mode, source_id,
            prompt_redacted, catalog_hash, spec, model, attempts,
            input_tokens, output_tokens, error
       FROM generation_log
      WHERE workspace_id = ANY($1)
        AND ($3 <= 0 OR created_at > now() - make_interval(days => $3))
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [workspaceIds, opts.limit, opts.retentionDays],
  );
  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    mode: row.mode as GenerationLogEntry["mode"],
    sourceId: row.source_id,
    promptRedacted: row.prompt_redacted,
    catalogHash: row.catalog_hash,
    spec: row.spec,
    model: row.model,
    attempts: row.attempts,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    error: row.error,
  }));
}

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

/* -------------------------------------------------------------------------- */
/* Dashboard chat history                                                     */
/* -------------------------------------------------------------------------- */

type ChatMessageRow = {
  id: string;
  role: string;
  content: unknown;
  created_at: string;
};

/**
 * One person's chat history on one dashboard, oldest first.
 *
 * Retention is applied on the way OUT as well as by the sweep on the way in:
 * a row that is past the window is not shown even if it is still on disk, so
 * shortening `CHAT_HISTORY_RETENTION_DAYS` takes effect immediately rather
 * than whenever someone next sends a message. `0` days disables the age check.
 *
 * `LIMIT` takes the NEWEST messages and the outer select puts them back in
 * order — the tail of a conversation is the part that has context.
 */
export async function listChatMessages(
  dashboardId: string,
  userSub: string,
  opts: { limit: number; retentionDays: number },
): Promise<StoredChatMessage[]> {
  const rows = await query<ChatMessageRow>(
    `SELECT id, role, content, created_at FROM (
       SELECT id, role, content, created_at
       FROM chat_messages
       WHERE dashboard_id = $1 AND user_sub = $2
         AND ($4 <= 0 OR created_at > now() - make_interval(days => $4))
       ORDER BY created_at DESC, id DESC
       LIMIT $3
     ) recent
     ORDER BY created_at ASC, id ASC`,
    [dashboardId, userSub, opts.limit, opts.retentionDays],
  );
  return rows.map((row) => ({
    id: row.id,
    role: row.role as StoredChatMessage["role"],
    content: row.content,
    createdAt: row.created_at,
  }));
}

/**
 * Append (or update) messages in one conversation and sweep what fell out of
 * retention.
 *
 * `ON CONFLICT ... DO UPDATE` rather than an insert: an assistant message is
 * streamed under one id and a turn may be re-sent, so the same id arriving
 * again means "this message grew", not "a second message".
 *
 * The sweep runs in the same transaction as the write, which is what keeps the
 * table from being unbounded without a scheduled job: the only way a row is
 * added is the only way rows are removed.
 */
export async function appendChatMessages(input: {
  dashboardId: string;
  userSub: string;
  messages: { id: string; role: string; content: unknown }[];
  limit: number;
  retentionDays: number;
}): Promise<void> {
  if (input.messages.length === 0) return;
  await withTransaction(async (client) => {
    for (const message of input.messages) {
      await client.query(
        `INSERT INTO chat_messages (id, dashboard_id, user_sub, role, content)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (dashboard_id, user_sub, id)
         DO UPDATE SET content = EXCLUDED.content`,
        [
          message.id,
          input.dashboardId,
          input.userSub,
          message.role,
          JSON.stringify(message.content),
        ],
      );
    }
    await client.query(
      `DELETE FROM chat_messages
       WHERE dashboard_id = $1 AND user_sub = $2
         AND (
           ($4 > 0 AND created_at <= now() - make_interval(days => $4))
           OR id NOT IN (
             SELECT id FROM chat_messages
             WHERE dashboard_id = $1 AND user_sub = $2
             ORDER BY created_at DESC, id DESC
             LIMIT $3
           )
         )`,
      [input.dashboardId, input.userSub, input.limit, input.retentionDays],
    );
  });
}

/** Forget one person's conversation on one dashboard. Returns how many rows went. */
export async function clearChatMessages(
  dashboardId: string,
  userSub: string,
): Promise<number> {
  const rows = await query<{ id: string }>(
    `DELETE FROM chat_messages
     WHERE dashboard_id = $1 AND user_sub = $2
     RETURNING id`,
    [dashboardId, userSub],
  );
  return rows.length;
}

/* -------------------------------------------------------------------------- */
/* User preferences (#213)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The stored preference object for one subject, unvalidated, or null when the
 * subject has never saved one. `parsePreferences` is the only thing that should
 * read the result.
 */
export async function getUserPreferences(sub: string): Promise<unknown | null> {
  const rows = await query<{ prefs: unknown }>(
    `SELECT prefs FROM user_preferences WHERE sub = $1`,
    [sub],
  );
  return rows[0]?.prefs ?? null;
}

/**
 * Merge an already-validated patch into one subject's row, creating it on the
 * first save. The merge is JSONB `||` in one statement, so two tabs saving
 * different fields at once cannot overwrite each other's change.
 */
export async function mergeUserPreferences(
  sub: string,
  patch: Record<string, unknown>,
): Promise<unknown> {
  const rows = await query<{ prefs: unknown }>(
    `INSERT INTO user_preferences (sub, prefs)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (sub)
     DO UPDATE SET prefs = user_preferences.prefs || EXCLUDED.prefs, updated_at = now()
     RETURNING prefs`,
    [sub, JSON.stringify(patch)],
  );
  return rows[0]?.prefs ?? patch;
}
