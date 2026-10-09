import { z } from "zod";
import { SECRET_REF_MESSAGE, SECRET_REF_PATTERN } from "@/lib/secret-refs";
import { TimescaleDbConfig, timescaledb } from "@/lib/sources/kinds/timescaledb";
import type { SourceCatalog } from "@/lib/sources/catalog";
import {
  type EditorCatalog,
  SourceConfig,
  type SourceKindName,
  sourceKind,
} from "@/lib/sources/registry";

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
export { SourceConnection, TimescaleDbConfig } from "@/lib/sources/kinds/timescaledb";
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
 *
 * `secretRef` is required exactly when the source needs credentials: always
 * for SQL, and for Prometheus unless `auth` is `"none"` (#385), where it must
 * be absent — a reference that names no credentials would be a grant with
 * nothing behind it.
 */
export const SourceDraftFields = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/i, "invalid source id"),
    name: z.string().min(1).max(200),
    secretRef: z.string().regex(SECRET_REF_PATTERN, SECRET_REF_MESSAGE).optional(),
    config: SourceConfig,
  })
  .strict();

/** Whether a config needs credentials, and so a `secret_ref`. */
export function needsSecretRef(cfg: SourceConfig): boolean {
  return !("auth" in cfg) || cfg.auth !== "none";
}

/** The `secret_ref` rule, for every schema built on {@link SourceDraftFields}. */
export function checkSecretRef(
  draft: { secretRef?: string | null; config: SourceConfig },
  ctx: z.RefinementCtx,
): void {
  const has = draft.secretRef !== undefined && draft.secretRef !== null;
  if (needsSecretRef(draft.config) && !has) {
    ctx.addIssue({
      code: "custom",
      path: ["secretRef"],
      message: "secretRef is required: it names where the credentials come from",
    });
  }
  if (!needsSecretRef(draft.config) && has) {
    ctx.addIssue({
      code: "custom",
      path: ["secretRef"],
      message: 'a source with auth "none" names no secretRef',
    });
  }
}

export const SourceDraft = SourceDraftFields.superRefine(checkSecretRef);
export type SourceDraft = z.infer<typeof SourceDraft>;

/** A SQL source's draft, as the form and the model hold it. */
export type SqlSourceDraft = Omit<SourceDraft, "config" | "secretRef"> & {
  config: TimescaleDbConfig;
  secretRef: string;
};

/**
 * What the model may draft: a {@link SourceDraft} without a row filter. Which
 * rows a tenant may see is a person's decision (#31), so the model is never
 * shown the field, and a draft that somehow carries one fails to parse.
 */
export const ModelSourceDraft = SourceDraftFields.extend({
  secretRef: z.string().regex(SECRET_REF_PATTERN, SECRET_REF_MESSAGE),
  // TimescaleDB only until a Prometheus draft exists (#386). The model is not
  // shown `kind` either: it has one answer here, which the default supplies.
  config: TimescaleDbConfig.omit({ rowFilter: true, kind: true }).strict(),
}).strict();

/**
 * What the editor may see of a source's catalog: projected by the source's
 * kind, which names the fields (see `SourceCatalog`), never spread.
 */
export function sourceCatalog(cfg: SourceConfig): EditorCatalog {
  return sourceKind(cfg).catalog(cfg);
}

/** A SQL source's catalog, as the SQL editor and hints read it. */
export function sqlCatalog(cfg: SqlSourceConfig): SourceCatalog {
  return timescaledb.catalog(cfg);
}

/** A SQL source's config: what the SQL guard, planner and executor read. */
export type SqlSourceConfig = TimescaleDbConfig;

/** A source the SQL path may run: narrowed by `isSqlSource` (`src/lib/sources/registry.ts`). */
export type SqlSourceRecord = Omit<SourceRecord, "kind" | "config" | "secretRef"> & {
  kind: "timescaledb";
  config: TimescaleDbConfig;
  /** A SQL source always names its credentials. */
  secretRef: string;
};

export interface SourceRecord {
  id: string;
  workspaceId: string;
  name: string;
  /** Checked against the registered kinds when the row is loaded. */
  kind: SourceKindName;
  config: SourceConfig;
  /**
   * The env family credentials resolve from, or null for a source that needs
   * none (a Prometheus source with `auth: "none"`, #385).
   */
  secretRef: string | null;
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
