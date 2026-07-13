import { z } from "zod";

/**
 * Source registry types.
 *
 * The registry owns the *safe* connection config and the catalog (the table +
 * column allowlist). Credentials are never stored; `secret_ref` names an
 * env-var family from which they are resolved at execution time.
 */

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
    columns: z.array(CatalogColumn).min(1).max(200),
  })
  .strict();
export type CatalogTable = z.infer<typeof CatalogTable>;

export const SourceConfig = z
  .object({
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    database: z.string().min(1).max(128),
    schema: z.string().min(1).max(128).default("public"),
    ssl: z.boolean().default(false),
    /** The table allowlist. Only these tables may be referenced by any SQL. */
    tables: z.array(CatalogTable).min(1).max(200),
  })
  .strict();
export type SourceConfig = z.infer<typeof SourceConfig>;

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
    secretRef: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, "secretRef must be an UPPER_SNAKE env family"),
    config: SourceConfig,
  })
  .strict();
export type SourceDraft = z.infer<typeof SourceDraft>;

export interface SourceRecord {
  id: string;
  workspaceId: string;
  name: string;
  kind: string;
  config: SourceConfig;
  secretRef: string;
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
  if (!/^[A-Z][A-Z0-9_]*$/.test(secretRef)) {
    throw new Error(`invalid secret_ref "${secretRef}"`);
  }
  const username = process.env[`${secretRef}_USERNAME`];
  const password = process.env[`${secretRef}_PASSWORD`];
  if (!username || password === undefined) {
    throw new Error(
      `credentials for secret_ref "${secretRef}" are not configured in the environment`,
    );
  }
  return { username, password };
}

/** The set of allowed (schema-qualified) table names for a source. */
export function allowedTables(cfg: SourceConfig): Set<string> {
  const set = new Set<string>();
  for (const t of cfg.tables) {
    set.add(t.name.toLowerCase());
    set.add(`${cfg.schema}.${t.name}`.toLowerCase());
  }
  return set;
}
