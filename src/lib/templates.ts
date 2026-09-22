import { z } from "zod";
import { appendPanel } from "@/lib/explore-save";
import { type ApiError, apiErrorFromThrown, readApiError } from "@/lib/errors";
import { Dashboard, Panel, type TimeRange } from "@/lib/ir";

/**
 * Panel and dashboard templates.
 *
 * A dashboard that works is currently trapped where it was built: the only way
 * to get "our standard service dashboard" onto a second service is to describe
 * it to the model again and hope. A template is that dashboard — or one good
 * panel out of it — kept as a reusable spec.
 *
 * Four things about the shape below are deliberate.
 *
 * - **A template body IS the IR.** It is a `Panel` or a `Dashboard` straight
 *   out of `src/lib/ir.ts`, not a parallel structure that would have to be
 *   kept in step with it. That is what makes "IR-validated on write and on
 *   instantiation" a consequence of the schema rather than a habit.
 * - **It therefore carries no credential and no connection detail** (invariant
 *   5): a panel references its source by an opaque id and nothing else, so a
 *   template is as safe to keep and hand around as the spec it came from.
 * - **Instantiation always re-points at a source the user picks.** The ids a
 *   stored template carries are the ones its author's panels had; they mean
 *   something only relative to one registry, and a template's whole purpose is
 *   to be applied somewhere else. {@link retargetTemplate} is explicit rather
 *   than name-matching for the same reason `remapSourceIds` is in
 *   `dashboard-export.ts`: a wrong guess points a panel at the wrong database
 *   and reports plausible numbers instead of failing.
 * - **Nothing here writes.** Applying a template produces an ordinary edited
 *   spec that goes through the existing create/save endpoints, so the guard
 *   runs against the chosen source's catalog, the workspace is derived from
 *   the trusted source records, and a dashboard built from a template is
 *   indistinguishable afterwards from one built by hand. There is no
 *   instantiate endpoint and there should not be one.
 */

export const TemplateKind = z.enum(["panel", "dashboard"]);
export type TemplateKind = z.infer<typeof TemplateKind>;

/**
 * The stored spec, tagged with which half of the IR it is.
 *
 * Tagged inside the body rather than only beside it in a column, so a body
 * stays self-describing wherever it travels — through an API payload, through
 * a React prop, into the `templates.kind` column that a CHECK constraint keeps
 * equal to this tag.
 */
export const TemplateBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("panel"), panel: Panel }).strict(),
  z.object({ kind: z.literal("dashboard"), dashboard: Dashboard }).strict(),
]);
export type TemplateBody = z.infer<typeof TemplateBody>;

/** Where a template came from: this workspace, or shipped with the app. */
export type TemplateOrigin = "workspace" | "builtin";

/**
 * One row of the picker.
 *
 * Provenance is optional because a built-in has none: it is derived from a
 * source's catalog at request time and was never written by anyone. Modelling
 * that as an optional author rather than as a second list is what lets one
 * picker show both.
 */
export interface Template {
  id: string;
  origin: TemplateOrigin;
  kind: TemplateKind;
  name: string;
  description?: string;
  body: TemplateBody;
  /** Absent on a built-in. */
  workspaceId?: string;
  createdBy?: string;
  createdAt?: string;
}

/** The IR caps a panel title at 200; a template name is the same thing. */
export const TemplateName = z.string().min(1).max(200);
export const TemplateDescription = z.string().max(500);

/** The create payload. `kind` is read off the body, never sent beside it. */
export const TemplateCreate = z
  .object({
    workspaceId: z.string().min(1).max(128),
    name: TemplateName,
    description: TemplateDescription.optional(),
    body: TemplateBody,
  })
  .strict();
export type TemplateCreate = z.infer<typeof TemplateCreate>;

/* -------------------------------------------------------------------------- */
/* Pure operations on a template body                                         */
/* -------------------------------------------------------------------------- */

/** The defaults a panel template gets when it becomes a whole dashboard. */
export const TEMPLATE_TIME_RANGE: TimeRange = { from: "now-1h", to: "now" };
export const TEMPLATE_REFRESH_MS = 30_000;

/** The panels a template contributes, in the order it holds them. */
export function templatePanels(body: TemplateBody): Panel[] {
  return body.kind === "panel" ? [body.panel] : body.dashboard.panels;
}

/** The source ids a template's panels reference, distinct, in spec order. */
export function templateSourceIds(body: TemplateBody): string[] {
  const seen: string[] = [];
  for (const panel of templatePanels(body)) {
    if (!seen.includes(panel.query.sourceId)) seen.push(panel.query.sourceId);
  }
  return seen;
}

/**
 * Point every panel in the template at one source. Pure: `body` is not
 * mutated, and nothing but `query.sourceId` moves — the SQL is the author's
 * and is not rewritten to fit a different schema. Whether it still passes the
 * guard against that source is the question `checkRepoint` answers, and the
 * picker asks it before anything is applied.
 */
export function retargetTemplate(body: TemplateBody, sourceId: string): TemplateBody {
  const retarget = (panel: Panel): Panel => ({
    ...panel,
    query: { ...panel.query, sourceId },
  });
  return body.kind === "panel"
    ? { kind: "panel", panel: retarget(body.panel) }
    : {
        kind: "dashboard",
        dashboard: { ...body.dashboard, panels: body.dashboard.panels.map(retarget) },
      };
}

/**
 * A template as a whole dashboard.
 *
 * A dashboard template keeps its own arrangement, refresh interval and time
 * range — that layout is most of what made it worth saving. A panel template
 * has none of those, so it gets the defaults above and its panel is placed at
 * the origin.
 */
export function templateSpec(
  body: TemplateBody,
  input: { title: string; sourceId?: string },
): Dashboard {
  const retargeted = input.sourceId ? retargetTemplate(body, input.sourceId) : body;
  const title = input.title.trim();
  if (retargeted.kind === "dashboard") {
    return { ...retargeted.dashboard, title };
  }
  return {
    title,
    timeRange: TEMPLATE_TIME_RANGE,
    refreshIntervalMs: TEMPLATE_REFRESH_MS,
    panels: [{ ...retargeted.panel, layout: { ...retargeted.panel.layout, x: 0, y: 0 } }],
  };
}

/**
 * Append a template's panels to an existing dashboard, at the bottom of the
 * grid and under ids unique within it.
 *
 * Folded through {@link appendPanel} one at a time, which is what keeps a
 * two-panel template from colliding with itself: each append sees the ids and
 * the bottom edge the previous one produced.
 */
export function appendTemplate(
  spec: Dashboard,
  body: TemplateBody,
  sourceId?: string,
): Dashboard {
  const retargeted = sourceId ? retargetTemplate(body, sourceId) : body;
  return templatePanels(retargeted).reduce(appendPanel, spec);
}

/**
 * The template a panel would become. The layout is dropped back to the origin
 * because placement is decided where the template lands, but the size is kept:
 * a stat tile and a wide time series are not interchangeable, and that is the
 * author's judgement, not the grid's.
 */
export function panelTemplateBody(panel: Panel): TemplateBody {
  return {
    kind: "panel",
    panel: Panel.parse({ ...panel, layout: { ...panel.layout, x: 0, y: 0 } }),
  };
}

/** The template a dashboard would become: the spec, whole and unaltered. */
export function dashboardTemplateBody(spec: Dashboard): TemplateBody {
  return { kind: "dashboard", dashboard: Dashboard.parse(spec) };
}

/**
 * A body as a dashboard the server can put through
 * `resolveAndValidateDashboard`.
 *
 * One code path for both kinds, so a panel template's SQL is guarded and its
 * workspace derived by exactly the call a dashboard save makes rather than by
 * a second, weaker check written for templates.
 */
export function templateValidationSpec(body: TemplateBody): Dashboard {
  return templateSpec(body, { title: "template" });
}

/** "3 panels · Demo TimescaleDB metrics" — the line under a picker row. */
export function summarizeTemplate(body: TemplateBody): string {
  const panels = templatePanels(body).length;
  return `${panels} ${panels === 1 ? "panel" : "panels"}`;
}

/* -------------------------------------------------------------------------- */
/* API helpers                                                                */
/* -------------------------------------------------------------------------- */

export type TemplateListOutcome =
  | { ok: true; templates: Template[] }
  | { ok: false; error: ApiError };

/**
 * The templates available in a workspace.
 *
 * `sourceId` is what adds the built-ins: they are parameterized by a source's
 * catalog, so there is nothing to offer until one is chosen, and the server
 * builds them rather than shipping the catalog to do it here.
 */
export async function fetchTemplates(input: {
  workspaceId: string;
  kind?: TemplateKind;
  sourceId?: string;
}): Promise<TemplateListOutcome> {
  try {
    const params = new URLSearchParams({ workspaceId: input.workspaceId });
    if (input.kind) params.set("kind", input.kind);
    if (input.sourceId) params.set("sourceId", input.sourceId);
    const res = await fetch(`/api/templates?${params.toString()}`);
    if (!res.ok) return { ok: false, error: await readApiError(res) };
    return { ok: true, templates: readTemplates(await res.json()) };
  } catch (err) {
    return { ok: false, error: apiErrorFromThrown(err) };
  }
}

export type TemplateSaveOutcome =
  | { ok: true; template: Template }
  | { ok: false; error: ApiError };

export async function saveTemplate(input: TemplateCreate): Promise<TemplateSaveOutcome> {
  try {
    const res = await fetch("/api/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) return { ok: false, error: await readApiError(res) };
    const template = readTemplate((await res.json())?.template);
    if (!template) {
      return {
        ok: false,
        error: {
          error: "The template was saved but not returned.",
          kind: "infrastructure",
        },
      };
    }
    return { ok: true, template };
  } catch (err) {
    return { ok: false, error: apiErrorFromThrown(err) };
  }
}

export async function deleteTemplate(
  id: string,
): Promise<{ ok: true } | { ok: false; error: ApiError }> {
  try {
    const res = await fetch(`/api/templates/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!res.ok) return { ok: false, error: await readApiError(res) };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: apiErrorFromThrown(err) };
  }
}

/**
 * A list body is trusted no further than its shape — and the body inside each
 * row no further than the IR. A row whose spec does not parse is dropped
 * rather than offered: a template that cannot be applied is worse in a picker
 * than one that is not there.
 */
export function readTemplates(body: unknown): Template[] {
  const record = (typeof body === "object" && body !== null ? body : {}) as {
    templates?: unknown;
  };
  if (!Array.isArray(record.templates)) return [];
  return record.templates.flatMap((row): Template[] => {
    const template = readTemplate(row);
    return template ? [template] : [];
  });
}

function readTemplate(input: unknown): Template | null {
  const row = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const body = TemplateBody.safeParse(row.body);
  const kind = TemplateKind.safeParse(row.kind);
  if (!body.success || !kind.success) return null;
  if (typeof row.id !== "string" || typeof row.name !== "string") return null;
  return {
    id: row.id,
    origin: row.origin === "builtin" ? "builtin" : "workspace",
    kind: kind.data,
    name: row.name,
    description: typeof row.description === "string" ? row.description : undefined,
    body: body.data,
    workspaceId: typeof row.workspaceId === "string" ? row.workspaceId : undefined,
    createdBy: typeof row.createdBy === "string" ? row.createdBy : undefined,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : undefined,
  };
}
