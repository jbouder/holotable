import { z } from "zod";
import { type Dashboard, type Panel, safeParseDashboard } from "@/lib/ir";
import { diffPanels, type PanelDiff } from "@/lib/panel-diff";
import { type ApiError, apiErrorFromThrown, readApiError } from "@/lib/errors";

/**
 * Version history (#73): what a dashboard's past versions look like to a
 * reader, how two of them differ, and the browser's half of the three routes.
 *
 * `dashboard_versions` is append-only (invariant 3), so the whole history is
 * already stored; this is the vocabulary for showing it. Restore never moves
 * `current_version_id` back to an old row: it appends a NEW version whose spec
 * is a copy of the old one, so the history keeps a record of the restore
 * itself and no row is ever edited.
 */

/** One row of the history list. Never carries the spec. */
export interface VersionSummary {
  version: number;
  /** The author's `sub`. An opaque id, already in every dashboard summary. */
  createdBy: string;
  /** ISO 8601. */
  createdAt: string;
  /** The author's "what changed" (#117), or a restore's own label. */
  note: string | null;
  panelCount: number;
}

/** One version in full: its row plus its spec, upgraded to the current IR. */
export interface VersionDetail extends VersionSummary {
  spec: Dashboard;
}

export interface VersionPage {
  versions: VersionSummary[];
  /** Pass as `before` for the next (older) page; null when this is the last. */
  nextBefore: number | null;
}

export const VERSION_PAGE_SIZE = 20;
export const VERSION_PAGE_MAX = 100;

/** Postgres `integer`. A larger path segment is a 400, not a driver error. */
const MAX_VERSION = 2_147_483_647;

export const VersionNumber = z.coerce.number().int().min(1).max(MAX_VERSION);

/**
 * `?before=&limit=` on the list route. Keyset pagination on the version number
 * rather than an offset: a save while someone pages through the history would
 * otherwise shift every later page by one.
 */
export const VersionListQuery = z.object({
  before: VersionNumber.optional(),
  limit: z.coerce.number().int().min(1).max(VERSION_PAGE_MAX).default(VERSION_PAGE_SIZE),
});

/**
 * The note a restore writes. The restored-from version is recorded here, in
 * the row's own words, because it is the only place a reader of the history
 * would look for it.
 */
export function restoreNote(version: number): string {
  return `restored from v${version}`;
}

/**
 * The author as the list shows them. There is no user directory to resolve a
 * `sub` against, and `Identity.displayName` is the caller's own, so the only
 * name that can be shown honestly is "you"; anyone else is a short form of
 * their id, with the full one in the row's tooltip.
 */
export function authorLabel(createdBy: string, viewerSub: string): string {
  if (createdBy === viewerSub) return "you";
  return createdBy.length > 8 ? `user ${createdBy.slice(0, 8)}` : `user ${createdBy}`;
}

/* -------------------------------------------------------------------------- */
/* Structural diff                                                            */
/* -------------------------------------------------------------------------- */

export interface DashboardFieldDiff {
  key: "title" | "timeRange" | "refresh";
  label: string;
  before: string;
  after: string;
  changed: boolean;
}

export type PanelChange =
  | { kind: "added"; panel: Panel }
  | { kind: "removed"; panel: Panel }
  | { kind: "changed"; before: Panel; after: Panel; diff: PanelDiff };

export interface DashboardDiff {
  fields: DashboardFieldDiff[];
  /** Added and changed in `after`'s order, then removed in `before`'s. */
  panels: PanelChange[];
  unchangedPanels: number;
  /** The panels both sides share appear in a different order. */
  reordered: boolean;
  identical: boolean;
}

function formatRefresh(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

function formatRange(range: Dashboard["timeRange"]): string {
  return `${range.from} → ${range.to}`;
}

/**
 * Compare two versions of one dashboard, panel by panel.
 *
 * Panels are matched by id, which the editor keeps stable across edits (and
 * `acceptedPanel` keeps stable across a generated edit), so a panel whose SQL
 * changed reads as one change rather than a removal and an addition. Each
 * matched pair goes through the same `diffPanels` the NL panel edit review
 * uses, so the history and that review describe a change the same way.
 */
export function diffDashboards(before: Dashboard, after: Dashboard): DashboardDiff {
  const field = (
    key: DashboardFieldDiff["key"],
    label: string,
    from: string,
    to: string,
  ): DashboardFieldDiff => ({
    key,
    label,
    before: from,
    after: to,
    changed: from !== to,
  });
  const fields = [
    field("title", "Title", before.title, after.title),
    field(
      "timeRange",
      "Time range",
      formatRange(before.timeRange),
      formatRange(after.timeRange),
    ),
    field(
      "refresh",
      "Refresh",
      formatRefresh(before.refreshIntervalMs),
      formatRefresh(after.refreshIntervalMs),
    ),
  ];

  const beforeById = new Map(before.panels.map((p) => [p.id, p]));
  const afterIds = new Set(after.panels.map((p) => p.id));

  const panels: PanelChange[] = [];
  let unchangedPanels = 0;
  for (const panel of after.panels) {
    const old = beforeById.get(panel.id);
    if (!old) {
      panels.push({ kind: "added", panel });
      continue;
    }
    const diff = diffPanels(old, panel);
    if (diff.identical) unchangedPanels++;
    else panels.push({ kind: "changed", before: old, after: panel, diff });
  }
  for (const panel of before.panels) {
    if (!afterIds.has(panel.id)) panels.push({ kind: "removed", panel });
  }

  const sharedBefore = before.panels.filter((p) => afterIds.has(p.id)).map((p) => p.id);
  const sharedAfter = after.panels.filter((p) => beforeById.has(p.id)).map((p) => p.id);
  const reordered = sharedBefore.some((id, i) => sharedAfter[i] !== id);

  return {
    fields,
    panels,
    unchangedPanels,
    reordered,
    identical: panels.length === 0 && !reordered && fields.every((f) => !f.changed),
  };
}

/* -------------------------------------------------------------------------- */
/* API helpers                                                                */
/* -------------------------------------------------------------------------- */

type Outcome<T> = ({ ok: true } & T) | { ok: false; error: ApiError };

function versionsUrl(dashboardId: string, version?: number): string {
  const base = `/api/dashboards/${encodeURIComponent(dashboardId)}/versions`;
  return version === undefined ? base : `${base}/${version}`;
}

const MALFORMED: ApiError = {
  error: "The version history could not be read.",
  kind: "infrastructure",
};

/** A response body is trusted no further than its shape. */
function readSummary(value: unknown): VersionSummary | null {
  const row = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  if (
    typeof row.version !== "number" ||
    typeof row.createdBy !== "string" ||
    typeof row.createdAt !== "string" ||
    typeof row.panelCount !== "number"
  ) {
    return null;
  }
  return {
    version: row.version,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    note: typeof row.note === "string" ? row.note : null,
    panelCount: row.panelCount,
  };
}

/** A page of older versions, newest first, and the current version's number. */
export async function fetchVersionPage(
  dashboardId: string,
  before: number | null,
): Promise<Outcome<VersionPage & { current: number | null }>> {
  try {
    const params = new URLSearchParams();
    if (before !== null) params.set("before", String(before));
    const qs = params.size > 0 ? `?${params.toString()}` : "";
    const res = await fetch(`${versionsUrl(dashboardId)}${qs}`);
    if (!res.ok) return { ok: false, error: await readApiError(res) };
    const body = (await res.json()) as {
      versions?: unknown;
      nextBefore?: unknown;
      current?: unknown;
    };
    if (!Array.isArray(body.versions)) return { ok: false, error: MALFORMED };
    const versions = body.versions.flatMap((v) => readSummary(v) ?? []);
    const nextBefore = typeof body.nextBefore === "number" ? body.nextBefore : null;
    const current = typeof body.current === "number" ? body.current : null;
    return { ok: true, versions, nextBefore, current };
  } catch (err) {
    return { ok: false, error: apiErrorFromThrown(err) };
  }
}

/** One version's spec, already upgraded by the server and re-checked here. */
export async function fetchVersion(
  dashboardId: string,
  version: number,
): Promise<Outcome<{ version: VersionDetail }>> {
  try {
    const res = await fetch(versionsUrl(dashboardId, version));
    if (!res.ok) return { ok: false, error: await readApiError(res) };
    const body = (await res.json()) as { version?: { spec?: unknown } };
    const summary = readSummary(body.version);
    const spec = safeParseDashboard(body.version?.spec);
    if (!summary || !spec.success) return { ok: false, error: MALFORMED };
    return { ok: true, version: { ...summary, spec: spec.data } };
  } catch (err) {
    return { ok: false, error: apiErrorFromThrown(err) };
  }
}

/** Append a new version that copies `version`'s spec. Returns the new number. */
export async function restoreVersion(
  dashboardId: string,
  version: number,
): Promise<Outcome<{ version: number }>> {
  try {
    const res = await fetch(`${versionsUrl(dashboardId, version)}/restore`, {
      method: "POST",
    });
    if (!res.ok) return { ok: false, error: await readApiError(res) };
    const body = (await res.json()) as { dashboard?: { version?: unknown } };
    const next = body.dashboard?.version;
    if (typeof next !== "number") return { ok: false, error: MALFORMED };
    return { ok: true, version: next };
  } catch (err) {
    return { ok: false, error: apiErrorFromThrown(err) };
  }
}
