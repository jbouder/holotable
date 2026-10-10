import { type ApiError, apiErrorFromThrown, readApiError } from "@/lib/errors";
import {
  type Dashboard,
  type Panel,
  SPEC_VERSION,
  safeParseDashboard,
  type TimeRange,
} from "@/lib/ir";
import { appendPanel, panelIdFromTitle } from "@/lib/panel-placement";

/**
 * Adding a Chat panel to a dashboard (#416).
 *
 * The two saves send the same `{spec}` body the editor sends, so the panel
 * goes through the ordinary save: `resolveAndValidateDashboard` derives the
 * workspace from the trusted source records, re-validates every statement,
 * and appends a version rather than changing one. Placing the panel is
 * `src/lib/panel-placement.ts`.
 */

/** A one-panel dashboard holding a Chat panel. */
export function newDashboardSpec(input: {
  title: string;
  panel: Panel;
  timeRange: TimeRange;
  refreshIntervalMs: number;
}): Dashboard {
  const { panel } = input;
  return {
    specVersion: SPEC_VERSION,
    title: input.title.trim(),
    timeRange: input.timeRange,
    refreshIntervalMs: input.refreshIntervalMs,
    panels: [
      {
        ...panel,
        id: panelIdFromTitle(panel.title),
        layout: { ...panel.layout, x: 0, y: 0 },
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* API helpers                                                                */
/* -------------------------------------------------------------------------- */

/** A row of the dashboard picker. */
export interface DashboardOption {
  id: string;
  title: string;
}

export type SaveOutcome =
  | { ok: true; dashboardId: string; panelId: string }
  | { ok: false; error: ApiError };

/**
 * Dashboards in `workspaceId` the caller may edit. The filtering is the
 * server's: `editable=true` narrows the identity's own workspaces by
 * `dashboard:update`, so the picker cannot list a dashboard the save would
 * then be refused for.
 */
export async function listEditableDashboards(
  workspaceId: string,
): Promise<{ ok: true; dashboards: DashboardOption[] } | { ok: false; error: ApiError }> {
  try {
    const params = new URLSearchParams({ workspaceId, editable: "true" });
    const res = await fetch(`/api/dashboards?${params.toString()}`);
    if (!res.ok) return { ok: false, error: await readApiError(res) };
    return { ok: true, dashboards: readDashboards(await res.json()) };
  } catch (err) {
    return { ok: false, error: apiErrorFromThrown(err) };
  }
}

/** A list body is trusted no further than its shape. */
function readDashboards(body: unknown): DashboardOption[] {
  const record = (typeof body === "object" && body !== null ? body : {}) as {
    dashboards?: unknown;
  };
  if (!Array.isArray(record.dashboards)) return [];
  return record.dashboards.flatMap((d): DashboardOption[] => {
    const row = (typeof d === "object" && d !== null ? d : {}) as Record<string, unknown>;
    return typeof row.id === "string" && typeof row.title === "string"
      ? [{ id: row.id, title: row.title }]
      : [];
  });
}

/**
 * Append the panel to an existing dashboard. The current spec is re-read first
 * so the appended version is built on what is stored, not on what the picker
 * happened to show.
 */
export async function saveToExistingDashboard(
  dashboardId: string,
  panel: Panel,
): Promise<SaveOutcome> {
  try {
    const current = await fetch(`/api/dashboards/${encodeURIComponent(dashboardId)}`);
    if (!current.ok) return { ok: false, error: await readApiError(current) };
    const spec = readSpec(await current.json());
    if (!spec) {
      return {
        ok: false,
        error: { error: "That dashboard could not be read.", kind: "infrastructure" },
      };
    }

    const next = appendPanel(spec, panel);
    const parsed = safeParseDashboard(next);
    if (!parsed.success) return { ok: false, error: invalidSpec(parsed.error.issues) };

    const res = await fetch(`/api/dashboards/${encodeURIComponent(dashboardId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: parsed.data }),
    });
    if (!res.ok) return { ok: false, error: await readApiError(res) };
    return {
      ok: true,
      dashboardId,
      panelId: parsed.data.panels[parsed.data.panels.length - 1].id,
    };
  } catch (err) {
    return { ok: false, error: apiErrorFromThrown(err) };
  }
}

/** Create a dashboard holding just this panel. */
export async function saveToNewDashboard(input: {
  title: string;
  panel: Panel;
  timeRange: TimeRange;
  refreshIntervalMs: number;
}): Promise<SaveOutcome> {
  const parsed = safeParseDashboard(newDashboardSpec(input));
  if (!parsed.success) return { ok: false, error: invalidSpec(parsed.error.issues) };
  try {
    const res = await fetch("/api/dashboards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: parsed.data }),
    });
    if (!res.ok) return { ok: false, error: await readApiError(res) };
    const id = readDashboardId(await res.json());
    if (!id) {
      return {
        ok: false,
        error: {
          error: "The dashboard was saved but not returned.",
          kind: "infrastructure",
        },
      };
    }
    return { ok: true, dashboardId: id, panelId: parsed.data.panels[0].id };
  } catch (err) {
    return { ok: false, error: apiErrorFromThrown(err) };
  }
}

function invalidSpec(issues: { message: string }[]): ApiError {
  return {
    error: `The dashboard would be invalid: ${issues[0]?.message ?? "validation failed"}`,
    kind: "validation",
  };
}

function readSpec(body: unknown): Dashboard | null {
  const record = (typeof body === "object" && body !== null ? body : {}) as {
    dashboard?: { spec?: unknown };
  };
  const parsed = safeParseDashboard(record.dashboard?.spec);
  return parsed.success ? parsed.data : null;
}

function readDashboardId(body: unknown): string | null {
  const record = (typeof body === "object" && body !== null ? body : {}) as {
    dashboard?: { id?: unknown };
  };
  const id = record.dashboard?.id;
  return typeof id === "string" && id ? id : null;
}
