import { z } from "zod";
import { LogqlQuery, type PanelQuery, PromqlQuery, SqlQuery } from "@/lib/ir";

/**
 * A request body that carries one panel query in any language (#385), for
 * `/api/query`, `/api/sql/plan` and `/api/sql/validate`. Each branch is the
 * IR's own strict query shape plus the route's fields, so a body naming two
 * of `sql`, `promql` and `logql` is refused, and the routes accept exactly
 * what a panel can hold. A LogQL body is accepted here and refused by the
 * source it names until a Loki kind can run it (#562).
 */
export function panelQueryBody<T extends z.ZodRawShape>(extra: T) {
  return z.union([
    SqlQuery.extend(extra),
    PromqlQuery.extend(extra),
    LogqlQuery.extend(extra),
  ]);
}

/** The panel query in a body, by its fields, never by spreading the body. */
export function panelQueryOf(
  body: { sourceId: string } & (
    | { sql: string; timeField?: string }
    | { promql: string; instant?: boolean; minStep?: string }
    | { logql: string; instant?: boolean; minStep?: string }
  ),
): PanelQuery {
  if ("sql" in body) {
    return {
      sourceId: body.sourceId,
      sql: body.sql,
      ...(body.timeField !== undefined ? { timeField: body.timeField } : {}),
    };
  }
  if ("logql" in body) {
    return {
      sourceId: body.sourceId,
      logql: body.logql,
      ...(body.instant !== undefined ? { instant: body.instant } : {}),
      ...(body.minStep !== undefined ? { minStep: body.minStep } : {}),
    };
  }
  return {
    sourceId: body.sourceId,
    promql: body.promql,
    ...(body.instant !== undefined ? { instant: body.instant } : {}),
    ...(body.minStep !== undefined ? { minStep: body.minStep } : {}),
  };
}
