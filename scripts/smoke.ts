import "./lib/env";
import { apiTokenHash, generateApiToken } from "@/lib/auth/api-token";
import { pgApiTokenStore } from "@/lib/db/api-tokens";
import { getDashboardById, getSourceById, listDashboards } from "@/lib/db/repo";
import { hasQuery, panelTimeRange, parseDashboard, type QueryPanel } from "@/lib/ir";
import { panelKind } from "@/lib/panels/registry";
import type { Dashboard } from "@/lib/ir";
import {
  SELF_DASHBOARD_TITLE,
  selfMonitoringSpec,
} from "@/lib/self-monitoring/dashboard";
import {
  LOKI_SELF_DASHBOARD_TITLE,
  lokiSelfMonitoringSpec,
} from "@/lib/self-monitoring/loki";
import {
  PROMETHEUS_SELF_DASHBOARD_TITLE,
  prometheusSelfMonitoringSpec,
} from "@/lib/self-monitoring/prometheus";
import { bindSourceRowFilter } from "@/lib/row-scope";
import type { SourcePlan } from "@/lib/sources/server/types";
import { resolveTimeRange } from "@/lib/time";
import { serverKind } from "@/lib/sources/server/registry";
import { demoSpec } from "./lib/demo-dashboards";
import { DEMO_FILES_DASHBOARD_TITLE, demoFilesSpec } from "./lib/demo-files";
import { seedWorkspace } from "./lib/seed-workspace";

/**
 * End-to-end smoke test for the self-monitoring demo (#54), its PromQL twin
 * (#390), which asks the compose stack's Prometheus the same questions, the
 * Holotable logs dashboard (#567), which reads the app's own log lines from
 * the `logs` profile's Loki while LOKI_SELF_URL is set, the service health
 * demo, whose custom visual (#405) must also compile, and the files demo
 * (#574), which reads Parquet, CSV and JSON files through DuckDB.
 *
 * Brings no stack up of its own — `docker compose` does that, or the
 * quick-start image, inside which it runs as well (#600) — and instead
 * asserts that what the stack produced actually works:
 *
 *   1. the seeder registered the `holotable-self` source and its dashboard;
 *   2. the spec the seeder stored still parses against the current IR and is
 *      the committed one, so the fixture and the database cannot drift;
 *   3. every panel's SQL passes the guard;
 *   4. at least one panel returns rows, which can only happen if the collector
 *      scraped the app's live `/api/metrics` and landed samples — or, for the
 *      PromQL dashboard, if Prometheus scraped it, and for the LogQL one, if
 *      Alloy shipped the app's lines to Loki.
 *
 * Steps 3 and 4 call the same functions `POST /api/query` calls, in the same
 * order, so a change that breaks guarded execution breaks this. They run in
 * this process, though, which has the full `node_modules`; the runtime image
 * has only what `next build` traced. So where SMOKE_APP_URL names the app,
 * one files-demo panel also runs through the app's own `POST /api/query`
 * (#615): DuckDB loads a native binding, and only the app can say whether
 * its image carries all of it. That request authenticates with a
 * service-account token (#288) minted here for the purpose, an editor of the
 * seeded workspace for ten minutes, and revoked once the answer is in.
 * What it deliberately does not cover is the session layer: a browser
 * reaching `/api/stream` needs a Keycloak login, which is not something CI
 * should be made to hold. `holotable_sse_subscribers` staying at zero in this
 * run is that gap, visible in the output.
 *
 * Only *some* panels can have rows in an idle stack — nobody has opened a
 * dashboard, so there are no pollers and no model calls — which is why the
 * assertion is "at least one", and why the per-panel counts are printed.
 */

const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 180_000);
const POLL_MS = 5_000;

interface PanelOutcome {
  panel: QueryPanel;
  rows: number;
  error?: string;
}

/** One self-monitoring dashboard: its title and the spec committed for it. */
interface Target {
  title: string;
  committed: () => Dashboard;
  /** What has to happen before a panel can have rows. */
  feeds: string;
  /** Also run a panel that had rows through the app (SMOKE_APP_URL). */
  throughApp?: boolean;
}

/** Where the app answers, for the request that goes through it. */
const APP_URL = process.env.SMOKE_APP_URL?.replace(/\/$/, "");

const TARGETS: Target[] = [
  {
    title: SELF_DASHBOARD_TITLE,
    committed: selfMonitoringSpec,
    feeds: "the collector needs a scrape or two",
  },
  // Only where the seeder registered it: compose names its Prometheus, and
  // the quick-start image, which has none, does not (#600).
  ...(process.env.PROMETHEUS_SELF_URL
    ? [
        {
          title: PROMETHEUS_SELF_DASHBOARD_TITLE,
          committed: prometheusSelfMonitoringSpec,
          feeds:
            "Prometheus needs a scrape or two (PROMETHEUS_SELF_URL empty skips this dashboard)",
        },
      ]
    : []),
  ...(process.env.LOKI_SELF_URL
    ? [
        {
          title: LOKI_SELF_DASHBOARD_TITLE,
          committed: lokiSelfMonitoringSpec,
          feeds:
            "the seeder registers it once Loki answers, and Alloy needs to ship the app's first lines (is the `logs` profile up? LOKI_SELF_URL empty skips this dashboard)",
        },
      ]
    : []),
  {
    title: "Demo service health",
    committed: () => parseDashboard(demoSpec()),
    feeds: "the seeder writes demo rows every few seconds",
  },
  // The files demo (#574): a DuckDB source over the Parquet, CSV and JSON files
  // the seeder writes under DUCKDB_SOURCES_DIR, which compose mounts here
  // read-only, as it does for the app. The seeder registers it only where
  // that is set.
  ...(process.env.DUCKDB_SOURCES_DIR
    ? [
        {
          title: DEMO_FILES_DASHBOARD_TITLE,
          committed: () => parseDashboard(demoFilesSpec()),
          feeds: "the seeder writes the files under DUCKDB_SOURCES_DIR first",
          throughApp: true,
        },
      ]
    : []),
];

async function findDashboard(title: string) {
  // Where the seeder put them: `demo`, or the local owner's workspace (#600).
  const { dashboards } = await listDashboards(seedWorkspace(), { search: title });
  const summary = dashboards.find((d) => d.title === title);
  if (!summary) return null;
  // Parses the stored spec against the IR on the way out; a spec the current
  // schema rejects fails here rather than silently rendering nothing.
  return getDashboardById(summary.id);
}

/** Run one panel exactly the way `POST /api/query` runs it. */
async function runPanel(
  panel: QueryPanel,
  range: { from: string; to: string },
): Promise<PanelOutcome> {
  const source = await getSourceById(panel.query.sourceId);
  if (!source || source.tombstonedAt) {
    return { panel, rows: 0, error: `unknown or removed source ${panel.query.sourceId}` };
  }

  const query = panel.query;
  const kind = serverKind(source);
  const check = await kind.check(source, query);
  if (!check.ok) return { panel, rows: 0, error: `guard refused: ${check.error}` };

  const resolved = resolveTimeRange({ from: range.from, to: range.to });
  let plan: SourcePlan;
  try {
    plan = kind.plan(source, query, {
      from: resolved.from,
      to: resolved.to,
      // A script has no viewer, so a row-filtered source refuses here.
      rowFilter: bindSourceRowFilter(source.config, () => undefined),
    });
  } catch (err) {
    return { panel, rows: 0, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const result = await serverKind(source).execute(source, plan);
    return { panel, rows: result.rows.length };
  } catch (err) {
    return { panel, rows: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Wait for the seeder, then for the first samples to be queryable. */
async function waitForData(target: Target, deadline: number) {
  let lastReason = "waiting for the seeder";
  for (;;) {
    const dashboard = await findDashboard(target.title).catch((err: unknown) => {
      lastReason = err instanceof Error ? err.message : String(err);
      return null;
    });

    if (dashboard) {
      const outcomes = await Promise.all(
        dashboard.spec.panels
          .filter(hasQuery)
          // A panel's own window when it has one (#114), as the poller runs it.
          .map((panel) =>
            runPanel(panel, panelTimeRange(panel, dashboard.spec.timeRange)),
          ),
      );
      const refused = outcomes.filter((o) => o.error);
      // A refusal is a real failure, not something more waiting would fix.
      if (refused.length > 0) return { dashboard, outcomes };
      if (outcomes.some((o) => o.rows > 0)) return { dashboard, outcomes };
      lastReason = `no panel has rows yet (${target.feeds})`;
    }

    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${TIMEOUT_MS}ms: ${lastReason}`);
    }
    console.log(`… ${lastReason}`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/**
 * JSON with every object's keys sorted. `jsonb` stores keys in its own order;
 * the IR's parse puts its own fields back in schema order, but a free-form
 * record (a custom visual's spec, #405) keeps the order it was read in, so
 * the comparison is of content, not of key order.
 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );
}

function assertCommittedSpec(target: Target, stored: unknown) {
  if (canonical(stored) !== canonical(target.committed())) {
    throw new Error(
      `the stored spec of "${target.title}" is not the committed one — the committed spec and the seeded dashboard have drifted. Re-seed, or delete the demo dashboard and let the seeder recreate it.`,
    );
  }
}

/**
 * One panel through the app's own `POST /api/query`, as the editor previews
 * it: the guard, the plan and the executor run in the app's process, from
 * the app's image. True when it answered with rows.
 */
async function runThroughApp(
  appUrl: string,
  panel: QueryPanel,
  timeRange: { from: string; to: string },
): Promise<boolean> {
  const token = generateApiToken();
  const record = await pgApiTokenStore.create({
    workspaceId: seedWorkspace(),
    name: "smoke",
    tokenHash: await apiTokenHash(token),
    role: "editor",
    createdBy: "smoke",
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  try {
    const res = await fetch(`${appUrl}/api/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...panel.query, timeRange }),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`  ✗ ${panel.id.padEnd(18)} through the app: ${res.status} ${text}`);
      return false;
    }
    const rows = (JSON.parse(text) as { rows?: unknown[] }).rows?.length ?? 0;
    if (rows === 0) {
      console.error(`  ✗ ${panel.id.padEnd(18)} through the app: no rows`);
      return false;
    }
    console.log(
      `  ✓ ${panel.id.padEnd(18)} ${rows} rows through the app's POST /api/query`,
    );
    return true;
  } finally {
    await pgApiTokenStore.revoke({ id: record.id, workspaceId: record.workspaceId });
  }
}

/** One dashboard's smoke: true when it passed. */
async function smokeOne(target: Target, deadline: number): Promise<boolean> {
  console.log(`smoke: ${target.title}`);
  const { dashboard, outcomes } = await waitForData(target, deadline);
  assertCommittedSpec(target, dashboard.spec);

  let failed = false;
  // A kind's own check, as a save runs it: a custom visual must compile.
  for (const panel of dashboard.spec.panels) {
    const problem = await panelKind(panel.viz).check?.(panel.options);
    if (problem) {
      failed = true;
      console.error(`  ✗ ${panel.id.padEnd(18)} ${problem}`);
    }
  }
  for (const { panel, rows, error } of outcomes) {
    if (error) {
      failed = true;
      console.error(`  ✗ ${panel.id.padEnd(18)} ${error}`);
    } else {
      console.log(`  ${rows > 0 ? "✓" : "·"} ${panel.id.padEnd(18)} ${rows} rows`);
    }
  }

  const populated = outcomes.filter((o) => !o.error && o.rows > 0);
  if (populated.length === 0) {
    failed = true;
    console.error(`no panel returned rows: ${target.feeds}, and it never happened`);
  }
  if (!failed) {
    console.log(`  ${populated.length}/${outcomes.length} panels returned rows`);
  }
  if (!failed && target.throughApp && APP_URL) {
    const { panel } = populated[0];
    const range = panelTimeRange(panel, dashboard.spec.timeRange);
    if (!(await runThroughApp(APP_URL, panel, range))) failed = true;
  }
  return !failed;
}

async function main() {
  console.log(`smoke: ${TARGETS.length} dashboards (timeout ${TIMEOUT_MS}ms)`);
  const deadline = Date.now() + TIMEOUT_MS;
  let ok = true;
  // In turn rather than at once, so each dashboard's lines print together.
  for (const target of TARGETS) {
    if (!(await smokeOne(target, deadline))) ok = false;
  }
  if (!ok) {
    console.error("smoke FAILED");
    process.exit(1);
  }
  console.log("smoke OK");
  process.exit(0);
}

main().catch((err) => {
  console.error("smoke FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
