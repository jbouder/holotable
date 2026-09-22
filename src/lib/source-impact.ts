import { z } from "zod";
import { type ApiError, apiErrorFromThrown, readApiError } from "@/lib/errors";

/**
 * What breaks if a source goes away.
 *
 * `deleteSource()` already refuses to hard-delete a referenced source and
 * tombstones it instead (invariant 6), so nothing is lost — but the person
 * pressing Delete saw none of it, and the author of an affected dashboard met
 * the consequence later as a panel that would not resolve. This module is the
 * contract that lets both sides be told first: the shape the impact endpoint
 * answers with, the counting and the wording built on it, and the one fetch
 * helper that asks.
 *
 * The payload is dashboard ids, dashboard titles and panel ids/titles — things
 * the caller may already read through `/api/dashboards` — and never a panel's
 * SQL or anything about the source's connection (invariant 5). The endpoint is
 * gated on `source:manage` in the source's own workspace, and the query is
 * scoped to that workspace, so impact cannot be used to enumerate dashboards
 * elsewhere.
 */

export const ImpactPanel = z
  .object({
    id: z.string(),
    title: z.string(),
  })
  .strict();
export type ImpactPanel = z.infer<typeof ImpactPanel>;

export const ImpactDashboard = z
  .object({
    id: z.string(),
    title: z.string(),
    panels: z.array(ImpactPanel),
  })
  .strict();
export type ImpactDashboard = z.infer<typeof ImpactDashboard>;

export const SourceImpact = z
  .object({
    sourceId: z.string(),
    dashboards: z.array(ImpactDashboard),
    /**
     * Whether ANY stored version names the source, current or superseded.
     *
     * `dashboards` is what breaks today; this is what decides whether a delete
     * tombstones. The two differ for a source that only an older version still
     * names — nothing is broken by removing it, and it is still tombstoned —
     * and the confirmation has to be told both or it promises the wrong thing.
     */
    referencedByAnyVersion: z.boolean(),
  })
  .strict();
export type SourceImpact = z.infer<typeof SourceImpact>;

export interface ImpactCounts {
  dashboards: number;
  panels: number;
}

export function impactCounts(impact: SourceImpact): ImpactCounts {
  return {
    dashboards: impact.dashboards.length,
    panels: impact.dashboards.reduce((n, d) => n + d.panels.length, 0),
  };
}

/** "3 panels across 2 dashboards", or "nothing" when the source is unused. */
export function describeImpact(impact: SourceImpact): string {
  const { dashboards, panels } = impactCounts(impact);
  if (panels === 0) return "nothing";
  return `${plural(panels, "panel")} across ${plural(dashboards, "dashboard")}`;
}

/**
 * The sentence shown next to the Delete button.
 *
 * It names the outcome the server will actually produce — tombstone, not
 * delete — because the two differ in what can be undone, and "deleted" would
 * be a promise `deleteSource()` does not keep.
 */
export function describeDeleteConsequence(impact: SourceImpact): string {
  if (impactCounts(impact).panels > 0) {
    return `This source is used by ${describeImpact(impact)}. Deleting will tombstone it, and those panels will stop resolving until they are re-pointed at another source.`;
  }
  if (impact.referencedByAnyVersion) {
    return "No current dashboard uses this source, but an earlier version of one still names it, so it will be tombstoned rather than removed.";
  }
  return "Nothing references this source, so it will be deleted outright.";
}

/** Whether deleting this source tombstones it instead of removing it. */
export function deleteTombstones(impact: SourceImpact): boolean {
  return impactCounts(impact).panels > 0 || impact.referencedByAnyVersion;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export type SourceImpactOutcome =
  | { ok: true; impact: SourceImpact }
  | { ok: false; error: ApiError };

export async function fetchSourceImpact(
  sourceId: string,
  init?: { signal?: AbortSignal },
): Promise<SourceImpactOutcome> {
  try {
    const res = await fetch(`/api/sources/${encodeURIComponent(sourceId)}/impact`, {
      signal: init?.signal,
    });
    if (!res.ok) return { ok: false, error: await readApiError(res) };
    const body: unknown = await res.json();
    const parsed = SourceImpact.safeParse(
      (body as { impact?: unknown } | null)?.impact ?? null,
    );
    return parsed.success
      ? { ok: true, impact: parsed.data }
      : {
          ok: false,
          error: { error: "the impact result was malformed", kind: "unknown" },
        };
  } catch (err) {
    return { ok: false, error: apiErrorFromThrown(err) };
  }
}
