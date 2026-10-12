import { createHash } from "node:crypto";
import type { CatalogColumn, SqlSourceConfig } from "@/lib/registry";

/**
 * What every SQL kind's refresh shares (#572): how a re-read column list
 * carries forward what the author said about each column, and the digest the
 * apply step must send back. Server-only (it hashes); the diff the preview
 * shows is `src/lib/catalog/refresh.ts`, which the browser also reads.
 */

/** One row of `information_schema.columns`, as a refresh reads it. */
export interface IntrospectedColumn {
  column_name: string;
  data_type: string;
}

/**
 * The columns a refresh stores for a table: the database's names, order and
 * types, carrying forward what the author said about each column by name — its
 * description and whether it is exposed. A refresh that reset `exposed` would
 * quietly re-expose every hidden column on the next click of "Refresh", so the
 * flag is the author's and survives. A column the database has gained since
 * has no prior entry and starts exposed, like every column of a new source.
 */
export function refreshedColumns(
  existing: CatalogColumn[],
  rows: IntrospectedColumn[],
): CatalogColumn[] {
  const previous = new Map(existing.map((column) => [column.name, column]));
  return rows.map((row) => {
    const prior = previous.get(row.column_name);
    return {
      ...(prior?.description !== undefined ? { description: prior.description } : {}),
      ...(prior?.exposed !== undefined ? { exposed: prior.exposed } : {}),
      name: row.column_name,
      type: row.data_type,
    };
  });
}

/**
 * A digest of exactly what a refresh would store: the catalog and the missing
 * list. The preview hands it out, and the apply step writes only if a second
 * introspection produces the same one. So nothing reaches the database that
 * the author has not reviewed, and the browser never sends the catalog itself.
 * An exposure toggle between the two steps also changes it, because the
 * refreshed config carries the flags forward.
 */
export function refreshDigest(refresh: {
  config: SqlSourceConfig;
  missingTables: string[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({ config: refresh.config, missingTables: refresh.missingTables }),
    )
    .digest("hex");
}
