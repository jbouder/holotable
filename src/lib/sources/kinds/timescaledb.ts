import { z } from "zod";
import type { SourceRecord } from "@/lib/registry";
import type { ListingBase } from "@/lib/source-listing";
import {
  CatalogTable,
  MAX_TABLES,
  RowFilter,
  type SourceCatalog,
  exposedTable,
} from "@/lib/sources/catalog";
import type { SourceKind } from "@/lib/sources/types";

/**
 * TimescaleDB (and plain PostgreSQL): the first source kind, and until #381
 * the only one. Everything here is what a source of this kind *is* and what
 * may be shown of it; how it is reached is the server half,
 * `src/lib/sources/server/timescaledb.ts`, which the browser bundle never
 * imports.
 */

/**
 * How to reach the database, without the catalog.
 *
 * Split out of {@link TimescaleDbConfig} so table discovery can be asked for
 * before an allowlist exists: the discovery route needs exactly these fields
 * and must not be handed a `tables` array it would have no use for. The config
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

/**
 * A TimescaleDB source's stored config.
 *
 * `kind` is the discriminator of the `SourceConfig` union. It is *defaulted*
 * rather than required because every config stored before the union existed
 * has no `kind` and must still parse; the repository writes it back into the
 * JSONB (and the column) on the next save, so the two can never disagree.
 */
export const TimescaleDbConfig = SourceConnection.extend({
  kind: z.literal("timescaledb").default("timescaledb"),
  /** The table allowlist. Only these tables may be referenced by any SQL. */
  tables: z.array(CatalogTable).min(1).max(MAX_TABLES),
  rowFilter: RowFilter.optional(),
}).strict();
export type TimescaleDbConfig = z.infer<typeof TimescaleDbConfig>;

/**
 * What the last Test or Refresh found the server to be (#557): the
 * TimescaleDB extension's version, or `null` for plain PostgreSQL (Neon,
 * Supabase, RDS and the rest), where `time_bucket` does not exist.
 *
 * Stored beside `config` in `sources.catalog_facts`, never inside it: the
 * server reads it from the server, and nothing a browser sends sets it. The
 * version string is shown to people, never to the model.
 */
export const TimescaleDbFacts = z
  .object({ timescaledb: z.string().min(1).max(64).nullable() })
  .strict();
export type TimescaleDbFacts = z.infer<typeof TimescaleDbFacts>;

/**
 * The facts for what `pg_extension` answered: the extension's version, held
 * to the schema's bound, or null when it is not installed.
 */
export function timescaleDbFacts(extversion: string | null): TimescaleDbFacts {
  return {
    timescaledb: extversion === null ? null : extversion.slice(0, 64) || "unknown",
  };
}

/**
 * How the server is named to a person: "PostgreSQL" or "TimescaleDB 2.17.2",
 * or null before any Test or Refresh has said which.
 */
export function timescaleDbEngine(
  facts: TimescaleDbFacts | null | undefined,
): string | null {
  if (!facts) return null;
  return facts.timescaledb === null ? "PostgreSQL" : `TimescaleDB ${facts.timescaledb}`;
}

/** A TimescaleDB source as someone who may use but not manage it sees it. */
export interface TimescaleDbListing extends ListingBase {
  kind: "timescaledb";
  schema: string;
  tableCount: number;
  /** "PostgreSQL" or "TimescaleDB 2.17.2" (#557); null until a Test or Refresh. */
  engine: string | null;
}

/**
 * A TimescaleDB source, as the code that connects to it holds it (#570): its
 * own config, and the `secret_ref` it always names. Narrowed to inside the
 * kind's server half (`src/lib/sources/server/timescaledb.ts`) and the
 * implementation behind it (`src/lib/timescaledb/`); the SQL path outside them
 * holds a `SqlSourceRecord`, which is any SQL kind's.
 */
export type TimescaleDbSourceRecord = Omit<
  SourceRecord,
  "kind" | "config" | "secretRef"
> & {
  kind: "timescaledb";
  config: TimescaleDbConfig;
  secretRef: string;
};

export const timescaledb = {
  kind: "timescaledb",
  label: "TimescaleDB",
  language: "sql",
  config: TimescaleDbConfig,
  facts: TimescaleDbFacts,
  engine: timescaleDbEngine,

  /** The connection half of a stored config, for a reconnect or a rediscovery. */
  connection(cfg: TimescaleDbConfig): SourceConnection {
    return {
      host: cfg.host,
      port: cfg.port,
      database: cfg.database,
      schema: cfg.schema,
      ssl: cfg.ssl,
    };
  },

  catalog(cfg: TimescaleDbConfig): SourceCatalog {
    return { schema: cfg.schema, tables: cfg.tables.map(exposedTable) };
  },

  listing(source: SourceRecord): TimescaleDbListing {
    const cfg = source.config;
    if (cfg.kind !== "timescaledb")
      throw new Error(`${source.id} is not a TimescaleDB source`);
    return {
      id: source.id,
      workspaceId: source.workspaceId,
      name: source.name,
      kind: "timescaledb",
      schema: cfg.schema,
      tableCount: cfg.tables.length,
      engine: timescaleDbEngine(source.catalogFacts),
      tombstonedAt: source.tombstonedAt,
    };
  },

  rowFilter(cfg: TimescaleDbConfig) {
    return cfg.rowFilter
      ? { target: cfg.rowFilter.column, claim: cfg.rowFilter.claim }
      : undefined;
  },
} as const satisfies SourceKind<
  "timescaledb",
  typeof TimescaleDbConfig,
  SourceCatalog,
  TimescaleDbListing
>;
