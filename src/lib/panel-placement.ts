import type { Dashboard, Panel } from "@/lib/ir";

/**
 * Placing a panel on a dashboard that already has some: an id unique within
 * it, and a place at the bottom of the grid where it overlaps nothing.
 * Arithmetic over a spec, so it needs no server. Chat's Add to dashboard
 * (#416) and templates (`src/lib/templates.ts`) both place through here.
 */

/** `Panel.id` caps at 64; leave room for a `-2` disambiguator. */
const ID_BASE_MAX = 56;
/** `PanelLayout.y` caps at 1000. */
const MAX_Y = 1000;

/**
 * Derive an id candidate from a panel title, so a saved panel reads as itself
 * in the spec instead of as `panel-m4x9q1`.
 */
export function panelIdFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ID_BASE_MAX)
    .replace(/-+$/, "");
  return slug || "panel";
}

/**
 * The first of `base`, `base-2`, `base-3`… that no existing panel uses.
 * Deterministic on purpose: a timestamped id would make the result untestable
 * and tells a reader nothing.
 */
export function uniquePanelId(taken: Iterable<string>, base: string): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** The y a new row starts at: below every panel already placed. */
export function bottomOf(panels: Panel[]): number {
  const bottom = panels.reduce((m, p) => Math.max(m, p.layout.y + p.layout.h), 0);
  return Math.min(bottom, MAX_Y);
}

/**
 * Append `panel` to `spec` at the bottom of the grid, under an id unique within
 * that dashboard. Pure: neither argument is mutated.
 */
export function appendPanel(spec: Dashboard, panel: Panel): Dashboard {
  const id = uniquePanelId(
    spec.panels.map((p) => p.id),
    panelIdFromTitle(panel.title),
  );
  return {
    ...spec,
    panels: [
      ...spec.panels,
      { ...panel, id, layout: { ...panel.layout, x: 0, y: bottomOf(spec.panels) } },
    ],
  };
}
