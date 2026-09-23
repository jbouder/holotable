import { getDashboardById, getSourceById, listDashboards } from "@/lib/db/repo";
import type { Panel } from "@/lib/ir";
import {
  SELF_DASHBOARD_TITLE,
  selfMonitoringSpec,
} from "@/lib/self-monitoring/dashboard";
import { buildExecutablePlan, validateSql } from "@/lib/sql/safety";
import { resolveTimeRange } from "@/lib/time";
import { executePlan } from "@/lib/timescaledb/client";

/**
 * End-to-end smoke test for the self-monitoring demo (#54).
 *
 * Brings no stack up of its own — `docker compose` does that — and instead
 * asserts that what compose produced actually works:
 *
 *   1. the seeder registered the `holotable-self` source and its dashboard;
 *   2. the spec the seeder stored still parses against the current IR and is
 *      the committed one, so the fixture and the database cannot drift;
 *   3. every panel's SQL passes the guard;
 *   4. at least one panel returns rows, which can only happen if the collector
 *      scraped the app's live `/api/metrics` and landed samples.
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
  panel: Panel;
  rows: number;
  error?: string;
}

async function findDashboard() {
  const { dashboards } = await listDashboards("demo", { search: SELF_DASHBOARD_TITLE });
  const summary = dashboards.find((d) => d.title === SELF_DASHBOARD_TITLE);
  if (!summary) return null;
  // Parses the stored spec against the IR on the way out; a spec the current
  // schema rejects fails here rather than silently rendering nothing.
  return getDashboardById(summary.id);
}

/** Run one panel exactly the way `POST /api/query` runs it. */
async function runPanel(
  panel: Panel,
  range: { from: string; to: string },
): Promise<PanelOutcome> {
  const source = await getSourceById(panel.query.sourceId);
  if (!source || source.tombstonedAt) {
    return { panel, rows: 0, error: `unknown or removed source ${panel.query.sourceId}` };
  }

  const check = await validateSql(panel.query.sql, source.config);
  if (!check.ok) return { panel, rows: 0, error: `guard refused: ${check.error}` };

  const resolved = resolveTimeRange({ from: range.from, to: range.to });
  const plan = buildExecutablePlan({
    sql: panel.query.sql,
    timeField: panel.query.timeField,
    from: resolved.from,
    to: resolved.to,
  });

  try {
    const result = await executePlan(source, plan);
    return { panel, rows: result.rows.length };
  } catch (err) {
    return { panel, rows: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Wait for the seeder, then for the collector's first samples to be queryable. */
async function waitForData(deadline: number) {
  let lastReason = "waiting for the seeder";
  for (;;) {
    const dashboard = await findDashboard().catch((err: unknown) => {
      lastReason = err instanceof Error ? err.message : String(err);
      return null;
    });

    if (dashboard) {
      const outcomes = await Promise.all(
        dashboard.spec.panels.map((panel) => runPanel(panel, dashboard.spec.timeRange)),
      );
      const refused = outcomes.filter((o) => o.error);
      // A refusal is a real failure, not something more waiting would fix.
      if (refused.length > 0) return { dashboard, outcomes };
      if (outcomes.some((o) => o.rows > 0)) return { dashboard, outcomes };
      lastReason = "no panel has rows yet (the collector needs a scrape or two)";
    }

    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${TIMEOUT_MS}ms: ${lastReason}`);
    }
    console.log(`… ${lastReason}`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

function assertCommittedSpec(stored: unknown) {
  const committed = JSON.stringify(selfMonitoringSpec());
  if (JSON.stringify(stored) !== committed) {
    throw new Error(
      "the stored spec is not the committed one — src/lib/self-monitoring/dashboard.ts and the seeded dashboard have drifted. Re-seed, or delete the demo dashboard and let the seeder recreate it.",
    );
  }
}

async function main() {
  console.log(`smoke: ${SELF_DASHBOARD_TITLE} (timeout ${TIMEOUT_MS}ms)`);
  const { dashboard, outcomes } = await waitForData(Date.now() + TIMEOUT_MS);
  assertCommittedSpec(dashboard.spec);

  let failed = false;
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
    console.error("no panel returned rows: the collector never landed a sample");
  }

  if (failed) {
    console.error("smoke FAILED");
    process.exit(1);
  }
  console.log(
    `smoke OK — ${populated.length}/${outcomes.length} panels streaming from the app's own metrics`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("smoke FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
