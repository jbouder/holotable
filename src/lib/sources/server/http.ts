import { HttpError } from "@/lib/auth/authorize";
import type { SourceRecord, SqlSourceRecord } from "@/lib/registry";
import { isSqlSource, sourceKind } from "@/lib/sources/registry";

/**
 * For the routes whose job is SQL by nature until #386 gives Prometheus its
 * own: browsing a catalog of tables and columns, refreshing it from the
 * database, hiding a column. Another kind is told so, by name, instead of
 * being handed a view of tables it does not have.
 */
export function requireSqlSource(source: SourceRecord, what: string): SqlSourceRecord {
  if (isSqlSource(source)) return source;
  throw new HttpError(
    400,
    `${what} is not available for a ${sourceKind(source).label} source yet`,
    {},
    "validation",
  );
}
