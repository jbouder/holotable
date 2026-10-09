import { z } from "zod";
import { SECRET_REF_MESSAGE, SECRET_REF_PATTERN } from "@/lib/secret-refs";
import type { SourceCatalog } from "@/lib/sources/catalog";
import { TimescaleDbConfig } from "@/lib/sources/kinds/timescaledb";
import { SourceConfig, type SourceKindName, sourceKind } from "@/lib/sources/registry";

/**
 * Source registry types.
 *
 * The registry owns the *safe* connection config and the catalog (the table +
 * column allowlist). Credentials are never stored; `secret_ref` names an
 * env-var family from which they are resolved at execution time, by
 * `resolveCredentials` in `@/lib/secrets/credentials` — and only in a
 * workspace `SOURCE_SECRET_REFS` grants the ref to. That half is server-only
 * and lives apart because this module is also bundled for the browser.
 */

export {
  CatalogColumn,
  CatalogTable,
  MAX_COLUMNS,
  MAX_TABLES,
  RowFilter,
  type SourceCatalog,
  allowedTables,
  exposedColumns,
  exposedTable,
  isExposed,
  unexposedColumns,
} from "@/lib/sources/catalog";
export { SourceConnection } from "@/lib/sources/kinds/timescaledb";
export { SourceConfig, type SourceKindName } from "@/lib/sources/registry";

/** The connection half of a stored config, for a reconnect or a rediscovery. */
export function sourceConnection(cfg: SourceConfig) {
  return sourceKind(cfg).connection(cfg);
}

/**
 * A drafted source: the full create payload minus the workspace (which is
 * supplied and authorized by the server, not the model). This is the contract
 * for the natural-language "draft a source" flow AND the base for the create
 * API body, so the two can never drift. The model emits ONLY this safe shape —
 * connection config + table catalog + the secret_ref *name*. It never emits
 * credentials; those are resolved from the environment via `secretRef`.
 */
export const SourceDraft = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/i, "invalid source id"),
    name: z.string().min(1).max(200),
    secretRef: z.string().regex(SECRET_REF_PATTERN, SECRET_REF_MESSAGE),
    config: SourceConfig,
  })
  .strict();
export type SourceDraft = z.infer<typeof SourceDraft>;

/**
 * What the model may draft: a {@link SourceDraft} without a row filter. Which
 * rows a tenant may see is a person's decision (#31), so the model is never
 * shown the field, and a draft that somehow carries one fails to parse.
 */
export const ModelSourceDraft = SourceDraft.extend({
  // TimescaleDB only until a Prometheus draft exists (#386). The model is not
  // shown `kind` either: it has one answer here, which the default supplies.
  config: TimescaleDbConfig.omit({ rowFilter: true, kind: true }).strict(),
}).strict();

/**
 * What the editor may see of a source's catalog: projected by the source's
 * kind, which names the fields (see `SourceCatalog`), never spread.
 */
export function sourceCatalog(cfg: SourceConfig): SourceCatalog {
  return sourceKind(cfg).catalog(cfg);
}

export interface SourceRecord {
  id: string;
  workspaceId: string;
  name: string;
  /** Checked against the registered kinds when the row is loaded. */
  kind: SourceKindName;
  config: SourceConfig;
  secretRef: string;
  /**
   * When the catalog was last introspected against the live database, or null
   * if it never has been. A drafted or hand-written catalog starts here, and
   * `src/lib/catalog/health.ts` is what turns that null into a refusal.
   */
  catalogRefreshedAt: string | null;
  /**
   * Allowlisted tables the last refresh could not find in the database. The
   * allowlist itself is the author's and a refresh never edits it, so drift is
   * recorded here instead of silently dropping the table or keeping its
   * columns as if they were still true.
   */
  catalogMissingTables: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  tombstonedAt: string | null;
}
