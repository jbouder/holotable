import { setColumnExposure } from "@/lib/catalog/browse";
import type { SourceConfig } from "@/lib/registry";
import type { ImpactDashboard } from "@/lib/source-impact";
import { checkSql } from "@/lib/sql/safety";

/**
 * Which panels hiding a column would break (#267). Server-only: it runs the
 * guard.
 *
 * The verdict is the guard's own, not a text search. Each panel's statement
 * is checked against the catalog as it stands and against the same catalog
 * with the column hidden, and a panel counts only when the first passes and
 * the second does not. So a `SELECT *`, a whole-row read or a `USING` join is
 * counted exactly the way #12 refuses it, and a panel that is already broken
 * for some other reason is not blamed on this change. Both checks use the
 * uncounted `checkSql`: a hypothetical is not a rejection.
 */

/** One stored panel and its statement, as `sourcePanelStatements()` loads them. */
export interface PanelStatement {
  dashboardId: string;
  dashboardTitle: string;
  panelId: string;
  panelTitle: string;
  sql: string;
}

/**
 * The dashboards and panels that hiding `table.column` would break, in input
 * order, or null when the column is not in the catalog. The result carries ids
 * and titles only; the SQL stays here.
 */
export async function hiddenColumnImpact(
  config: SourceConfig,
  panels: PanelStatement[],
  table: string,
  column: string,
): Promise<ImpactDashboard[] | null> {
  const hidden = setColumnExposure(config, table, column, false);
  if (!hidden) return null;

  const dashboards: ImpactDashboard[] = [];
  for (const panel of panels) {
    if (!(await checkSql(panel.sql, config)).ok) continue;
    if ((await checkSql(panel.sql, hidden)).ok) continue;
    let dashboard = dashboards.find((d) => d.id === panel.dashboardId);
    if (!dashboard) {
      dashboard = { id: panel.dashboardId, title: panel.dashboardTitle, panels: [] };
      dashboards.push(dashboard);
    }
    dashboard.panels.push({ id: panel.panelId, title: panel.panelTitle });
  }
  return dashboards;
}
