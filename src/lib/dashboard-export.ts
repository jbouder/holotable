import { z } from "zod";
import { type ApiError, apiErrorFromThrown, readApiError } from "@/lib/errors";
import { Dashboard, type Panel } from "@/lib/ir";

/**
 * The door a dashboard leaves and enters by.
 *
 * A dashboard otherwise exists only as rows in `dashboard_versions`, so there
 * is no way to hand someone a starting dashboard, copy one between a local
 * stack and a real deployment, or keep one under review. The spec is already a
 * self-contained validated document; all this adds is an envelope around it.
 *
 * Two things make that envelope safe to pass around, and both are load-bearing.
 *
 * - It is an explicit ALLOWLIST, not a spread of a `DashboardRecord`. The
 *   record carries a workspace id and the creating subject; the source registry
 *   behind it carries hosts, ports and a `secret_ref`. None of that belongs in
 *   a file someone emails, and none of it can arrive here by accident because
 *   {@link buildDashboardExport} names every field it writes.
 *   `test/dashboard-export.test.ts` pins that field set, in the shape of
 *   `test/panel-details.test.ts`.
 * - A panel references its source by an opaque id only (invariant 5), so
 *   exporting the spec verbatim exports no connection detail. That is also why
 *   an import cannot simply trust those ids: they mean something only relative
 *   to a registry, so the target workspace re-resolves them and an id it does
 *   not have is an explicit refusal rather than a guess.
 */

/** The envelope tag. A file without it is not ours and is refused as such. */
export const EXPORT_FORMAT = "holotable.dashboard";

/**
 * The version of the ENVELOPE, not of any one dashboard.
 *
 * The IR itself carries no version today, so this is the hook a future
 * migration would key on: bump it, and a reader knows both what shape to
 * expect and that an older reader should refuse rather than misread.
 */
export const EXPORT_FORMAT_VERSION = 1;

/**
 * What a reader can learn without parsing the spec: what this is, how big, and
 * what registry it expects to land in. Informational only — every importer
 * decision is made from `spec`, so a doctored manifest changes nothing.
 */
export const ExportManifest = z
  .object({
    title: z.string().min(1).max(200),
    panelCount: z.number().int().min(0).max(1_000),
    /** The dashboard version this file was taken from, for provenance. */
    dashboardVersion: z.number().int().min(0),
    /** The source ids the panels reference, distinct, in spec order. */
    sourceIds: z.array(z.string().min(1).max(128)).max(50),
  })
  .strict();
export type ExportManifest = z.infer<typeof ExportManifest>;

/**
 * The file. `.strict()` at both levels is what turns "wrong shape" and
 * "unknown fields" into a 400 instead of a field that is silently ignored.
 *
 * `manifest` is optional on the way in: the spec is the authority, so a
 * hand-written file that carries only `format`, `formatVersion` and `spec` is
 * a perfectly good import.
 */
export const DashboardExportFile = z
  .object({
    format: z.literal(EXPORT_FORMAT, {
      error: `not a ${EXPORT_FORMAT} file`,
    }),
    formatVersion: z.literal(EXPORT_FORMAT_VERSION, {
      error: `unsupported export format version (this build reads version ${EXPORT_FORMAT_VERSION})`,
    }),
    exportedAt: z.string().max(64).optional(),
    manifest: ExportManifest.optional(),
    spec: Dashboard,
  })
  .strict();
export type DashboardExportFile = z.infer<typeof DashboardExportFile>;

/** What {@link buildDashboardExport} writes: every field of the file, filled. */
export interface DashboardExport extends DashboardExportFile {
  exportedAt: string;
  manifest: ExportManifest;
}

/**
 * Build the file for a stored dashboard.
 *
 * Takes the spec and the version number and nothing else — deliberately not a
 * `DashboardRecord`, so there is no object in scope here whose extra fields
 * could leak into the payload.
 */
export function buildDashboardExport(
  input: { spec: Dashboard; version: number },
  now: Date = new Date(),
): DashboardExport {
  const spec = Dashboard.parse(input.spec);
  return {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: now.toISOString(),
    manifest: {
      title: spec.title,
      panelCount: spec.panels.length,
      dashboardVersion: input.version,
      sourceIds: referencedSourceIds(spec),
    },
    spec,
  };
}

/** The source ids the panels reference, distinct, in the order they appear. */
export function referencedSourceIds(spec: { panels: Panel[] }): string[] {
  const seen: string[] = [];
  for (const panel of spec.panels) {
    if (!seen.includes(panel.query.sourceId)) seen.push(panel.query.sourceId);
  }
  return seen;
}

/**
 * The referenced ids the target registry does not offer, in spec order.
 *
 * "Does not offer" is decided by the caller passing the live, untombstoned
 * sources of ONE workspace, which is what makes a source in a workspace the
 * importer cannot see read as absent rather than as someone else's: an import
 * discloses no membership it was not already granted.
 */
export function unresolvedSourceIds(
  spec: { panels: Panel[] },
  availableIds: Iterable<string>,
): string[] {
  const available = new Set(availableIds);
  return referencedSourceIds(spec).filter((id) => !available.has(id));
}

/** The mapping shape an import may carry: original source id → target id. */
export const SourceMapping = z.record(
  z.string().min(1).max(128),
  z.string().min(1).max(128),
);
export type SourceMapping = z.infer<typeof SourceMapping>;

/**
 * Re-point every panel through `mapping`. Pure: `spec` is not mutated, an id
 * the mapping does not name is left alone, and nothing but `query.sourceId`
 * moves.
 *
 * The mapping is explicit rather than inferred on purpose. Matching sources by
 * name or by catalog shape would silently point a panel at the wrong database
 * on an import the user believed was a copy, and the failure would surface as
 * plausible-looking numbers rather than as an error.
 */
export function remapSourceIds(spec: Dashboard, mapping: SourceMapping): Dashboard {
  return {
    ...spec,
    panels: spec.panels.map((panel) => {
      const target = mapping[panel.query.sourceId];
      return target ? { ...panel, query: { ...panel.query, sourceId: target } } : panel;
    }),
  };
}

/** Room for `holotable-` and `.json` inside a filename that stays readable. */
const SLUG_MAX = 48;

/**
 * The download filename.
 *
 * A title is user-controlled and reaches a `Content-Disposition` header, where
 * a quote or a newline would be header injection, so the slug is reduced to
 * `[a-z0-9-]` rather than escaped — there is no legitimate title this loses
 * anything a reader needs, and the file's real title is inside it.
 */
export function exportFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
  return `holotable-${slug || "dashboard"}.json`;
}

/* -------------------------------------------------------------------------- */
/* API helpers                                                                */
/* -------------------------------------------------------------------------- */

/** A workspace the caller may import into, with the sources it offers. */
export interface ImportTarget {
  workspaceId: string;
  /** Projected server-side: an id and a name, never a catalog or a host. */
  sources: { id: string; name: string }[];
}

/** Read a picked file's text into a validated envelope, for the preview. */
export function readExportFile(
  text: string,
): { ok: true; file: DashboardExportFile } | { ok: false; error: ApiError } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: { error: "That file is not JSON.", kind: "validation" } };
  }
  const parsed = DashboardExportFile.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        error: `That file is not a dashboard export: ${
          parsed.error.issues[0]?.message ?? "validation failed"
        }`,
        kind: "validation",
      },
    };
  }
  return { ok: true, file: parsed.data };
}

export type ImportOutcome =
  | { ok: true; dashboardId: string }
  | { ok: false; error: ApiError };

/**
 * Create a dashboard from an export file.
 *
 * The client's own parse above is a courtesy for the preview and decides
 * nothing: the route re-parses the same envelope, re-resolves the sources
 * against the target workspace, and re-validates every statement, so an
 * import that skipped this function entirely would be held to the same terms.
 */
export async function importDashboard(input: {
  workspaceId: string;
  file: DashboardExportFile;
  sourceMapping: SourceMapping;
}): Promise<ImportOutcome> {
  try {
    const res = await fetch("/api/dashboards/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) return { ok: false, error: await readApiError(res) };
    const id = readDashboardId(await res.json());
    if (!id) {
      return {
        ok: false,
        error: {
          error: "The dashboard was imported but not returned.",
          kind: "infrastructure",
        },
      };
    }
    return { ok: true, dashboardId: id };
  } catch (err) {
    return { ok: false, error: apiErrorFromThrown(err) };
  }
}

function readDashboardId(body: unknown): string | null {
  const record = (typeof body === "object" && body !== null ? body : {}) as {
    dashboard?: { id?: unknown };
  };
  const id = record.dashboard?.id;
  return typeof id === "string" && id ? id : null;
}
