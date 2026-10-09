import { randomBytes } from "node:crypto";
import { Client } from "pg";
import {
  type SqlSourceRecord,
  type SqlSourceConfig,
  TimescaleDbConfig,
} from "@/lib/registry";
import { secretRefEnvVars } from "@/lib/secret-refs";

/**
 * Shared setup for the suites `npm run test:integration` runs (#87).
 *
 * The runner (`scripts/test-integration.ts`) puts a migrated TimescaleDB in
 * `MIGRATE_TEST_DATABASE_URL`, initialized by `timescaledb/init`, and the
 * read-only role's login in `INTEGRATION_METRICS_*`. Without it every test
 * here skips, which is how `npm test` runs these files at no cost.
 */

export const dbUrl = process.env.MIGRATE_TEST_DATABASE_URL;

/** The `skip` option for a test that needs the server. */
export const needsDb = {
  skip: dbUrl ? false : "run with npm run test:integration (needs Docker)",
};

/** A short random suffix, so concurrent suites never share a row or a name. */
export function unique(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

/** A connection as the database owner, for setup the app itself never does. */
export async function ownerClient(database?: string): Promise<Client> {
  const url = new URL(dbUrl as string);
  if (database) url.pathname = `/${database}`;
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  return client;
}

export type Role = "readonly" | "owner";

/**
 * Grant `ref` to `workspaceId` and point it at a role: the read-only one the
 * init script creates, which is what a source is configured with, or the
 * database owner, to prove a guarantee holds even for a privileged login.
 */
export function grantRef(
  ref: string,
  workspaceId: string,
  role: Role = "readonly",
): void {
  const url = new URL(dbUrl as string);
  const vars = secretRefEnvVars(ref);
  const grants = (process.env.SOURCE_SECRET_REFS ?? "")
    .split(";")
    .filter((g) => g && !g.startsWith(`${ref}:`));
  process.env.SOURCE_SECRET_REFS = [...grants, `${ref}:${workspaceId}`].join(";");
  if (role === "owner") {
    process.env[vars.username] = decodeURIComponent(url.username);
    process.env[vars.password] = decodeURIComponent(url.password);
  } else {
    process.env[vars.username] = process.env.INTEGRATION_METRICS_USERNAME ?? "metrics_ro";
    process.env[vars.password] = process.env.INTEGRATION_METRICS_PASSWORD ?? "readonly";
  }
}

/** The connection half of a source on the integration database. */
export function connection(): Pick<SqlSourceConfig, "host" | "port" | "database"> {
  const url = new URL(dbUrl as string);
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    database: url.pathname.slice(1),
  };
}

/** The demo `http_requests` table as a source allowlists it. */
export const HTTP_REQUESTS = {
  name: "http_requests",
  columns: [
    { name: "ts", type: "timestamp with time zone" },
    { name: "service", type: "text" },
    { name: "route", type: "text" },
    { name: "status", type: "smallint" },
    { name: "duration_ms", type: "double precision" },
    { name: "bytes", type: "bigint" },
  ],
};

/** A source on the `metrics` schema, allowlisting `http_requests` alone. */
export function metricsSource(input: {
  id: string;
  workspaceId: string;
  secretRef: string;
}): SqlSourceRecord {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    name: input.id,
    kind: "timescaledb",
    config: TimescaleDbConfig.parse({
      ...connection(),
      schema: "metrics",
      tables: [HTTP_REQUESTS],
    }),
    secretRef: input.secretRef,
    catalogRefreshedAt: null,
    catalogMissingTables: [],
    createdBy: "integration",
    createdAt: "2026-10-05T00:00:00Z",
    updatedAt: "2026-10-05T00:00:00Z",
    tombstonedAt: null,
  };
}
