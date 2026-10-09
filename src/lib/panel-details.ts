import { isSqlQuery, queryTimeField } from "@/lib/ir";
import type { Panel } from "@/lib/ir";

/**
 * What a viewer is allowed to see about how a panel is computed.
 *
 * This is an explicit allowlist rather than a spread of `panel.query`: a panel
 * references its data source through an opaque `sourceId` only, and nothing
 * reaching this shape may carry connection details or a `secret_ref`. Widening
 * it is a deliberate act, and `test/panel-details.test.ts` pins the field set.
 */
export type PanelDetails = {
  sourceId: string;
  timeField?: string;
  description?: string;
} & ({ sql: string } | { promql: string });

/** How a panel is computed, or null for one that computes nothing (#202). */
export function panelDetails(panel: Panel): PanelDetails | null {
  if (!panel.query) return null;
  // The statement under its language's name, each named rather than spread.
  const query = panel.query;
  return {
    ...(isSqlQuery(query) ? { sql: query.sql } : { promql: query.promql }),
    sourceId: query.sourceId,
    timeField: queryTimeField(query),
    description: panel.description,
  };
}
