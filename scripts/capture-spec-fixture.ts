import "./lib/env";
import { execFileSync } from "node:child_process";
import { Client } from "pg";
import { hasQuery } from "@/lib/ir";
import { StoredDashboard } from "@/lib/ir/upgrade";
import { SourceConfig } from "@/lib/registry";
import {
  addFixture,
  type Catalogs,
  CATALOGS_FILE,
  FIXTURES_DIR,
  MANIFEST_FILE,
} from "./lib/spec-fixtures";

/**
 * Capture a stored dashboard spec as an IR fixture (#90).
 *
 *   npm run fixture:capture -- <dashboard-id> --name <slug>
 *     [--version <n>]          a version other than the current one
 *     [--source <id>=<new-id>] re-point a source id (repeatable)
 *
 * Reads the `dashboard_versions.spec` jsonb exactly as it was saved, without
 * upgrading it, and adds it to `test/fixtures/specs/` with the catalog of
 * every source it reads, so `test/ir-contract.test.ts` holds every later build
 * to loading it. Nothing is redacted because nothing needs to be: a spec names
 * its sources by opaque id and carries no connection detail or credential
 * (invariant 4), and the catalog written beside it is the schema and table
 * allowlist alone, never the host, port, database or `secret_ref`.
 *
 * Refuses a spec the current build cannot read. A fixture is a promise that it
 * keeps loading, and one that already fails is a bug report, not a fixture.
 */

const USAGE =
  "Usage: npm run fixture:capture -- <dashboard-id> --name <slug> [--version <n>] [--source <id>=<new-id>]";

interface Args {
  dashboardId: string;
  slug: string;
  version: number | null;
  renames: Map<string, string>;
}

function parseArgs(argv: string[]): Args {
  let dashboardId: string | null = null;
  let slug: string | null = null;
  let version: number | null = null;
  const renames = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--name") slug = argv[++i] ?? null;
    else if (arg === "--version") {
      version = Number(argv[++i]);
      if (!Number.isInteger(version) || version < 1) {
        throw new Error(`--version needs a positive integer. ${USAGE}`);
      }
    } else if (arg === "--source") {
      const [from, to] = (argv[++i] ?? "").split("=");
      if (!from || !to) throw new Error(`--source needs <id>=<new-id>. ${USAGE}`);
      renames.set(from, to);
    } else if (!arg.startsWith("--") && dashboardId === null) dashboardId = arg;
    else throw new Error(`Unknown argument '${arg}'. ${USAGE}`);
  }
  if (!dashboardId || !slug) throw new Error(USAGE);
  return { dashboardId, slug, version, renames };
}

/** Rewrite every `sourceId` in a stored spec, whatever version it is. */
function renameSources(value: unknown, renames: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => renameSources(v, renames));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key,
      key === "sourceId" && typeof v === "string"
        ? (renames.get(v) ?? v)
        : renameSources(v, renames),
    ]),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{
      title: string;
      version: number;
      spec: unknown;
    }>(
      `SELECT d.title, dv.version, dv.spec
         FROM dashboards d
         JOIN dashboard_versions dv
           ON dv.dashboard_id = d.id
          AND (CASE WHEN $2::int IS NULL THEN dv.id = d.current_version_id
                    ELSE dv.version = $2 END)
        WHERE d.id = $1`,
      [args.dashboardId, args.version],
    );
    const row = rows[0];
    if (!row) {
      throw new Error(
        `no dashboard ${args.dashboardId}${args.version ? ` version ${args.version}` : ""}`,
      );
    }

    const parsed = StoredDashboard.safeParse(row.spec);
    if (!parsed.success) {
      throw new Error(
        `the stored spec does not load under this build, so it is not a fixture: ${parsed.error.message}`,
      );
    }

    // The catalogs, read under the ids the spec has now; written under the
    // ids it will have after any --source rename.
    const ids = new Set<string>();
    for (const panel of parsed.data.panels.filter(hasQuery))
      ids.add(panel.query.sourceId);
    for (const v of parsed.data.variables ?? []) if (v.query) ids.add(v.query.sourceId);
    const catalogs: Catalogs = {};
    for (const id of ids) {
      const res = await client.query<{ config: unknown }>(
        "SELECT config FROM sources WHERE id = $1",
        [id],
      );
      if (!res.rows[0])
        throw new Error(`the spec reads source "${id}", which does not exist`);
      const config = SourceConfig.parse(res.rows[0].config);
      // A catalog is the allowlist alone: tables for SQL, metrics for PromQL.
      catalogs[args.renames.get(id) ?? id] =
        "tables" in config
          ? {
              schema: config.schema,
              tables: config.tables,
              ...(config.rowFilter ? { rowFilter: config.rowFilter } : {}),
            }
          : {
              metrics: config.metrics.map((m) => ({ name: m.name, labels: m.labels })),
              ...(config.rowFilter ? { rowFilter: config.rowFilter } : {}),
            };
    }

    const path = addFixture({
      slug: args.slug,
      spec: renameSources(row.spec, args.renames),
      catalogs,
      origin: `captured: dashboard "${row.title}" version ${row.version}`,
    });
    // The formatter owns the layout of every JSON file in the repository.
    execFileSync(
      "npx",
      [
        "biome",
        "format",
        "--write",
        path,
        `${FIXTURES_DIR}/${CATALOGS_FILE}`,
        `${FIXTURES_DIR}/${MANIFEST_FILE}`,
      ],
      { stdio: "ignore" },
    );
    console.log(`captured ${path}`);
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
