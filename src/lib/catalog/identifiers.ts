import type { CatalogTable } from "@/lib/registry";
import { isTimestampType } from "@/lib/source-form";

/**
 * The two questions every catalog-derived query has to answer before it can
 * write a line of SQL: is this name safe to interpolate, and which column will
 * the server filter time on.
 *
 * Both answers are shared by `src/lib/builtin-templates.ts` and
 * `src/lib/panel-starter.ts`, which generate SQL text from names that come out
 * of a database the operator may not control. A name that is not an ordinary
 * unquoted identifier disqualifies its table or column rather than being
 * escaped: there is no quoting rule these modules could apply that would keep
 * the result both correct and obviously safe to read, and the cost of skipping
 * is one starter that is not offered.
 *
 * `src/lib/prompts/starters.ts` applies the same rule with its own copy,
 * because there the consequence is a bad *suggestion* rather than generated
 * SQL, and the two should be free to diverge.
 */

/** An ordinary unquoted SQL identifier — see the note above. */
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

export function isPlainIdentifier(name: string): boolean {
  return PLAIN_IDENTIFIER.test(name);
}

/**
 * The column the server will filter time on, or null.
 *
 * The declared `timeField` first — its author said so — then the first
 * timestamp-typed column.
 */
export function timeColumn(table: CatalogTable): string | null {
  if (table.timeField && isPlainIdentifier(table.timeField)) return table.timeField;
  const found = table.columns.find(
    (c) => isPlainIdentifier(c.name) && isTimestampType(c.type),
  );
  return found ? found.name : null;
}
