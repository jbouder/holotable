import {
  type Dashboard,
  hasQuery,
  type Panel,
  panelTimeRange,
  type QueryPanel,
} from "@/lib/ir";
import type { VariableValues } from "@/lib/sql/variables";

/**
 * Which panels of a previewed spec need their query run again (#357).
 *
 * The editor's canvas is the live dashboard, and the spec changes on every
 * keystroke and every drag. Re-running every query on each of those would be a
 * request per panel per character, and a moved panel shows the same rows it
 * did before it moved. So a panel is run when what its result depends on
 * changes — its query, the window it is read over, the variable values bound —
 * and not when its title, kind, options or position do.
 */

/** Everything a panel's result depends on, as one comparable string. */
export function previewRunKey(
  panel: QueryPanel,
  dashboardRange: Dashboard["timeRange"],
  variables: VariableValues,
): string {
  return JSON.stringify([panel.query, panelTimeRange(panel, dashboardRange), variables]);
}

/** The panels whose key differs from the one their shown result was run with. */
export function panelsToRun(
  panels: readonly Panel[],
  dashboardRange: Dashboard["timeRange"],
  variables: VariableValues,
  lastRun: Readonly<Record<string, string>>,
): { panel: QueryPanel; key: string }[] {
  return panels
    .filter(hasQuery)
    .map((panel) => ({ panel, key: previewRunKey(panel, dashboardRange, variables) }))
    .filter(({ panel, key }) => lastRun[panel.id] !== key);
}
