import type { z } from "zod";

/**
 * Which dashboards a generated link may lead to (#375), and the rule that
 * holds a generation to them. Browser-safe: the route checks a generation
 * against the list it built, and the browser, which validates the same
 * stream with its own schema, checks it against the same list read from
 * {@link LINK_TARGETS_HEADER}, so a link to an invented id fails on both
 * sides and the one repair (#21) runs with the reason.
 */

/** The response header carrying the ids a generation's links may name. */
export const LINK_TARGETS_HEADER = "X-Link-Targets";

/** The header's value: the ids, comma-separated. Ids are UUIDs, so no escaping. */
export function linkTargetsHeader(ids: readonly string[]): string {
  return ids.join(",");
}

/** The ids a header carries; null when there was none (the rule then does not apply). */
export function parseLinkTargetsHeader(value: string | null): string[] | null {
  if (value === null) return null;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

interface LinkLike {
  title?: unknown;
  dashboard?: unknown;
}

function panelsOf(value: unknown): unknown[] {
  if (typeof value !== "object" || value === null) return [];
  const v = value as { panels?: unknown };
  return Array.isArray(v.panels) ? v.panels : [value];
}

/**
 * The links in a generated dashboard or panel that name a dashboard not in
 * `allowed`: what the model invented. A self link names none and is fine.
 */
export function unknownLinkTargets(
  value: unknown,
  allowed: readonly string[],
): { panel: number; link: number; title: string; dashboard: string }[] {
  const out: { panel: number; link: number; title: string; dashboard: string }[] = [];
  panelsOf(value).forEach((panel, p) => {
    const links = (panel as { links?: unknown })?.links;
    if (!Array.isArray(links)) return;
    links.forEach((raw, l) => {
      const link = raw as LinkLike;
      if (typeof link?.dashboard !== "string") return;
      if (allowed.includes(link.dashboard)) return;
      out.push({
        panel: p,
        link: l,
        title: typeof link.title === "string" ? link.title : "",
        dashboard: link.dashboard,
      });
    });
  });
  return out;
}

/**
 * A generation's schema, held to `allowed` as well: a link to any other
 * dashboard is an issue that names it, so the repair prompt says what to fix.
 * The JSON Schema the model is bound to is unchanged; this is a refinement.
 */
export function withKnownLinkTargets<S extends z.ZodType>(
  schema: S,
  allowed: readonly string[],
): S {
  return schema.superRefine((value, ctx) => {
    const isDashboard =
      typeof value === "object" &&
      value !== null &&
      Array.isArray((value as { panels?: unknown }).panels);
    for (const bad of unknownLinkTargets(value, allowed)) {
      ctx.addIssue({
        code: "custom",
        message: `link "${bad.title}" names dashboard "${bad.dashboard}", which is not in the DASHBOARDS list; use an id from that list, or omit "dashboard" for this dashboard`,
        path: isDashboard
          ? ["panels", bad.panel, "links", bad.link, "dashboard"]
          : ["links", bad.link, "dashboard"],
      });
    }
  }) as unknown as S;
}
