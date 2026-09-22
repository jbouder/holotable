import { z } from "zod";
import {
  SECRET_REF_MESSAGE,
  SECRET_REF_PATTERN,
  secretRefEnvVars,
} from "@/lib/secret-refs";

/**
 * Source registry types.
 *
 * The registry owns the *safe* connection config and the catalog (the table +
 * column allowlist). Credentials are never stored; `secret_ref` names an
 * env-var family from which they are resolved at execution time.
 */

/**
 * The allowlist caps, named because discovery has to honour them too: the menu
 * a source author picks from can never be allowed to exceed what a valid
 * `SourceConfig` could hold.
 */
export const MAX_TABLES = 200;
export const MAX_COLUMNS = 200;

export const CatalogColumn = z
  .object({
    name: z.string().min(1).max(128),
    type: z.string().min(1).max(64),
    description: z.string().max(500).optional(),
  })
  .strict();
export type CatalogColumn = z.infer<typeof CatalogColumn>;

export const CatalogTable = z
  .object({
    name: z.string().min(1).max(128),
    description: z.string().max(500).optional(),
    /** Preferred time column for server-injected time filtering. */
    timeField: z.string().min(1).max(128).optional(),
    columns: z.array(CatalogColumn).min(1).max(MAX_COLUMNS),
  })
  .strict();
export type CatalogTable = z.infer<typeof CatalogTable>;

/**
 * How to reach the database, without the catalog.
 *
 * Split out of {@link SourceConfig} so table discovery can be asked for before
 * an allowlist exists: the discovery route needs exactly these fields and must
 * not be handed a `tables` array it would have no use for. `SourceConfig`
 * extends it, so the two can never drift in their constraints.
 */
export const SourceConnection = z
  .object({
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    database: z.string().min(1).max(128),
    schema: z.string().min(1).max(128).default("public"),
    ssl: z.boolean().default(false),
  })
  .strict();
export type SourceConnection = z.infer<typeof SourceConnection>;

export const SourceConfig = SourceConnection.extend({
  /** The table allowlist. Only these tables may be referenced by any SQL. */
  tables: z.array(CatalogTable).min(1).max(MAX_TABLES),
}).strict();
export type SourceConfig = z.infer<typeof SourceConfig>;

/** The connection half of a stored config, for a reconnect or a rediscovery. */
export function sourceConnection(cfg: SourceConfig): SourceConnection {
  return {
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    schema: cfg.schema,
    ssl: cfg.ssl,
  };
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
 * The part of a source that may be sent to a browser: the schema name and the
 * table allowlist with its columns, and nothing else.
 *
 * The editor needs the catalog to complete table and column names and to warn
 * about a table the guard will refuse. It does not need — and invariant 5 says
 * it must not receive — the host, port, database, TLS setting or `secret_ref`
 * that sit beside the catalog in {@link SourceConfig}. Projecting through
 * {@link sourceCatalog} rather than spreading the config is what keeps a field
 * added to `SourceConfig` later from reaching the client by default.
 */
export type SourceCatalog = Pick<SourceConfig, "schema" | "tables">;

export function sourceCatalog(cfg: SourceConfig): SourceCatalog {
  return { schema: cfg.schema, tables: cfg.tables };
}

export interface SourceRecord {
  id: string;
  workspaceId: string;
  name: string;
  kind: string;
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

export interface SourceCredentials {
  username: string;
  password: string;
}

/**
 * Resolve credentials for a source from the environment using its secret_ref.
 * `secret_ref` "TS_METRICS" resolves TS_METRICS_USERNAME / TS_METRICS_PASSWORD.
 *
 * The read-only user is expected here; execution never uses a privileged user.
 */
export function resolveCredentials(secretRef: string): SourceCredentials {
  if (!SECRET_REF_PATTERN.test(secretRef)) {
    throw new Error(`invalid secret_ref "${secretRef}"`);
  }
  const env = secretRefEnvVars(secretRef);
  const username = process.env[env.username];
  const password = process.env[env.password];
  if (!username || password === undefined) {
    throw new Error(
      `credentials for secret_ref "${secretRef}" are not configured in the environment`,
    );
  }
  return { username, password };
}

/**
 * Whether the server holds credentials for `secretRef` — a boolean, and only a
 * boolean. This is what the readiness indicator reports, so it is deliberately
 * the *same* call an execution makes rather than a second opinion about the
 * environment: whatever would make `resolveCredentials` throw is exactly what
 * makes this answer false, and no future divergence is possible.
 */
export function hasCredentials(secretRef: string): boolean {
  try {
    resolveCredentials(secretRef);
    return true;
  } catch {
    return false;
  }
}

/**
 * The set of allowed table names for a source, bare and schema-qualified,
 * exactly as the catalog spells them.
 *
 * Names are compared character for character, never case-folded. PostgreSQL
 * folds an *unquoted* identifier to lowercase and preserves the case of a
 * *quoted* one, so `"HTTP_REQUESTS"` is a different relation from
 * `http_requests`. The parser applies the same folding before the guard sees
 * a name, so an exact comparison here is exactly the server's resolution;
 * lowercasing on either side would collapse the two into one.
 */
export function allowedTables(cfg: SourceCatalog): Set<string> {
  const set = new Set<string>();
  for (const t of cfg.tables) {
    set.add(t.name);
    set.add(`${cfg.schema}.${t.name}`);
  }
  return set;
}
