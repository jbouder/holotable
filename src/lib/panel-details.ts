import type { Panel } from "@/lib/ir";

/**
 * What a viewer is allowed to see about how a panel is computed.
 *
 * This is an explicit allowlist rather than a spread of `panel.query`: a panel
 * references its data source through an opaque `sourceId` only, and nothing
 * reaching this shape may carry connection details or a `secret_ref`. Widening
 * it is a deliberate act, and `test/panel-details.test.ts` pins the field set.
 */
export interface PanelDetails {
  sql: string;
  sourceId: string;
  timeField?: string;
  description?: string;
}

export function panelDetails(panel: Panel): PanelDetails {
  return {
    sql: panel.query.sql,
    sourceId: panel.query.sourceId,
    timeField: panel.query.timeField,
    description: panel.description,
  };
}
