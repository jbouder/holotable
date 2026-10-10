import "./lib/env";
import { getDashboardById, getSourceById, listDashboards } from "@/lib/db/repo";
import { hasQuery, parseDashboard, type QueryPanel } from "@/lib/ir";
import { panelKind } from "@/lib/panels/registry";
import type { Dashboard } from "@/lib/ir";
import {
  SELF_DASHBOARD_TITLE,
  selfMonitoringSpec,
} from "@/lib/self-monitoring/dashboard";
import {
  PROMETHEUS_SELF_DASHBOARD_TITLE,
  prometheusSelfMonitoringSpec,
} from "@/lib/self-monitoring/prometheus";
import { bindSourceRowFilter } from "@/lib/row-scope";
import type { SourcePlan } from "@/lib/sources/server/types";
import { resolveTimeRange } from "@/lib/time";
import { serverKind } from "@/lib/sources/server/registry";
import { customVisualsSpec } from "./lib/demo-dashboards";

/**
 * End-to-end smoke test for the self-monitoring demo (#54), its PromQL twin
 * (#390), which asks the compose stack's Prometheus the same questions, and
 * the custom-visuals demo (#405), whose panels must also compile.
 *
 * Brings no stack up of its own — `docker compose` does that — and instead
 * asserts that what compose produced actually works:
 *
 *   1. the seeder registered the `holotable-self` source and its dashboard;
 *   2. the spec the seeder stored still parses against the current IR and is
 *      the committed one, so the fixture and the database cannot drift;
 *   3. every panel's SQL passes the guard;
 *   4. at least one panel returns rows, which can only happen if the collector
 *      scraped the app's live `/api/metrics` and landed samples — or, for the
 *      PromQL dashboard, if Prometheus scraped it.
 *
 * Steps 3 and 4 call the same functions `POST /api/query` calls, in the same
 * order, so a change that breaks guarded execution breaks this. What it
 * deliberately does not cover is the HTTP and session layer above them: a
 * browser reaching `/api/stream` needs a Keycloak login, which is not
 * something CI should be made to hold. `holotable_sse_subscribers` staying at
 * zero in this run is that gap, visible in the output.
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
}

const TARGETS: Target[] = [
  {
    title: SELF_DASHBOARD_TITLE,
    committed: selfMonitoringSpec,
    feeds: "the collector needs a scrape or two",
  },
  {
    title: PROMETHEUS_SELF_DASHBOARD_TITLE,
    committed: prometheusSelfMonitoringSpec,
    feeds: "Prometheus needs a scrape or two",
  },
  {
    title: "Demo custom visuals",
    committed: () => parseDashboard(customVisualsSpec()),
    feeds: "the seeder writes demo rows every few seconds",
  },
];

async function findDashboard(title: string) {
  const { dashboards } = await listDashboards("demo", { search: title });
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
          .map((panel) => runPanel(panel, dashboard.spec.timeRange)),
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

function assertCommittedSpec(target: Target, stored: unknown) {
  const committed = JSON.stringify(target.committed());
  if (JSON.stringify(stored) !== committed) {
    throw new Error(
      `the stored spec of "${target.title}" is not the committed one — src/lib/self-monitoring/ and the seeded dashboard have drifted. Re-seed, or delete the demo dashboard and let the seeder recreate it.`,
    );
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
    console.log(
      `  ${populated.length}/${outcomes.length} panels streaming from the app's own metrics`,
    );
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
