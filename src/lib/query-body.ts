import { z } from "zod";
import { type PanelQuery, PromqlQuery, SqlQuery } from "@/lib/ir";

/**
 * A request body that carries one panel query in either language (#385),
 * for `/api/query`, `/api/sql/plan` and `/api/sql/validate`. Each branch is
 * the IR's own strict query shape plus the route's fields, so a body naming
 * both `sql` and `promql` is refused, and the routes accept exactly what a
 * panel can hold.
 */
export function panelQueryBody<T extends z.ZodRawShape>(extra: T) {
  return z.union([SqlQuery.extend(extra), PromqlQuery.extend(extra)]);
}

/** The panel query in a body, by its fields, never by spreading the body. */
export function panelQueryOf(
  body: { sourceId: string } & (
    | { sql: string; timeField?: string }
    | { promql: string; instant?: boolean; minStep?: string }
  ),
): PanelQuery {
  if ("sql" in body) {
    return {
      sourceId: body.sourceId,
      sql: body.sql,
      ...(body.timeField !== undefined ? { timeField: body.timeField } : {}),
    };
  }
  return {
    sourceId: body.sourceId,
    promql: body.promql,
    ...(body.instant !== undefined ? { instant: body.instant } : {}),
    ...(body.minStep !== undefined ? { minStep: body.minStep } : {}),
  };
}
