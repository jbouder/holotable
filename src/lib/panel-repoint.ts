import type { Panel } from "@/lib/ir";
import { type SqlCheck, validatePanelSql } from "@/lib/panel-query";

/**
 * Moving panels off a source that is no longer there.
 *
 * A tombstoned source leaves its panels in a state nothing else in the editor
 * can clear: the panel still names a source id, `resolveAndValidateDashboard`
 * refuses the whole spec on save because that source is tombstoned, and so the
 * dashboard cannot be edited at all until the reference is changed. Re-point is
 * that change — pick another source in the same workspace and rewrite
 * `query.sourceId`.
 *
 * Everything here is pure and works on the spec in the editor. There is no
 * re-point endpoint and there should not be one: the result is an ordinary
 * edited spec, saved through the same `PUT /api/dashboards/[id]` as any other
 * change, so it appends a version and never mutates one, and every statement is
 * re-validated server-side against the new source on the way in.
 *
 * What is NOT done here is rewriting SQL to fit a different schema. The check
 * below reports, per panel, whether the statement still passes the guard
 * against the new source's catalog; a panel that fails is the author's to fix
 * (or to leave behind), not this module's to rewrite.
 */

/**
 * The source ids panels reference that are not among the live sources, in the
 * order the panels first name them.
 *
 * "Not live" is the only signal the editor has and it is the right one: the
 * page loads the workspace's untombstoned sources, so a missing id is a source
 * that was tombstoned, hard-deleted, or belongs to another workspace — all of
 * which fail the same way on save and are fixed the same way.
 */
export function missingSourceIds(
  panels: Panel[],
  liveSourceIds: Iterable<string>,
): string[] {
  const live = new Set(liveSourceIds);
  const missing: string[] = [];
  for (const panel of panels) {
    const id = panel.query.sourceId;
    if (!live.has(id) && !missing.includes(id)) missing.push(id);
  }
  return missing;
}

/** Every panel pointing at `sourceId`, in spec order — the bulk re-point set. */
export function panelsUsingSource(panels: Panel[], sourceId: string): Panel[] {
  return panels.filter((p) => p.query.sourceId === sourceId);
}

/**
 * Re-point `panelIds` at `sourceId`. Pure: `panels` is not mutated, and a panel
 * keeps its id, title, layout, viz, format, SQL and time field — only the
 * source reference moves.
 */
export function repointPanels(
  panels: Panel[],
  input: { panelIds: Iterable<string>; sourceId: string },
): Panel[] {
  const ids = new Set(input.panelIds);
  return panels.map((panel) =>
    ids.has(panel.id)
      ? { ...panel, query: { ...panel.query, sourceId: input.sourceId } }
      : panel,
  );
}

/** One panel's verdict against a candidate source. */
export interface RepointCheck {
  panelId: string;
  title: string;
  check: SqlCheck;
}

/**
 * Re-validate each panel's SQL against the candidate source's catalog.
 *
 * The same `validateSql` the save will run, reached through the same
 * `/api/sql/validate` the editor already uses, so the verdict shown here is the
 * verdict the save will reach. Checked in parallel because the calls are
 * independent and a dashboard can carry up to 50 panels.
 */
export async function checkRepoint(
  panels: Panel[],
  sourceId: string,
): Promise<RepointCheck[]> {
  return Promise.all(
    panels.map(async (panel) => ({
      panelId: panel.id,
      title: panel.title,
      check: await validatePanelSql({ sourceId, sql: panel.query.sql }),
    })),
  );
}

/** "2 of 3 panels still validate" — the line above the re-point button. */
export function summarizeChecks(checks: RepointCheck[]): string {
  const ok = checks.filter((c) => c.check.ok).length;
  const one = checks.length === 1;
  return `${ok} of ${checks.length} ${one ? "panel" : "panels"} still ${
    one ? "validates" : "validate"
  } against this source`;
}
