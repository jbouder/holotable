import { type Dashboard, parseDashboard, SPEC_VERSION } from "@/lib/ir";
import { LokiConfig, type LokiLabel } from "@/lib/sources/kinds/loki";

/**
 * The self-monitoring demo's third source (#567): Holotable's own log lines,
 * which the compose stack's `logs` profile ships to Loki with Grafana Alloy.
 * The SQL and PromQL dashboards read what the app counts; this one reads what
 * it says. Every server line is one JSON object (`src/lib/log.ts`): `level`,
 * `time`, `msg`, and inside a request `requestId` and `route`, with
 * `request.completed` / `request.rejected` / `request.failed` adding
 * `method`, `status` and `durationMs`, and `guard.refused` adding the
 * `language` and `reason` of a refusal. The panels parse those with `| json`
 * and filter on them; a line that is not JSON (the server's start banner)
 * fails the parse and is left out with `__error__=""`.
 *
 * `test/self-monitoring.test.ts` holds every panel to the real LogQL guard
 * against the committed label allowlist, with no hint.
 */

export const LOKI_SELF_SOURCE_ID = "loki-self";

export const LOKI_SELF_DASHBOARD_TITLE = "Holotable logs";

/** Where the compose stack's Loki answers, from inside the network. */
export const LOKI_SELF_URL = "http://loki:3100";

/** The stream the panels read: the compose service the app runs as. */
const APP = 'app="app"';

/**
 * The labels Alloy attaches (`docker-compose.yml`): `app` is the compose
 * service, `env` the stack, `container` the container's name. The values are
 * the ones the stack is known to have; the seeder adds whatever discovery
 * finds on the live Loki, as the source form would.
 */
export function lokiSelfLabels(): LokiLabel[] {
  return [
    {
      name: "app",
      values: [
        "alloy",
        "app",
        "keycloak",
        "loki",
        "postgres",
        "prometheus",
        "seed",
        "self-metrics",
      ],
    },
    { name: "container", values: [] },
    { name: "env", values: ["dev"] },
  ];
}

/** The `loki-self` source's config: unauthenticated, on the compose network. */
export function lokiSelfConfig(
  url = LOKI_SELF_URL,
  labels: LokiLabel[] = lokiSelfLabels(),
): LokiConfig {
  return LokiConfig.parse({ kind: "loki", url, auth: "none", labels });
}

function spec(): unknown {
  const sourceId = LOKI_SELF_SOURCE_ID;
  return {
    specVersion: SPEC_VERSION,
    title: LOKI_SELF_DASHBOARD_TITLE,
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 15_000,
    panels: [
      {
        id: "lines-by-level",
        title: "Log lines by level per minute",
        description:
          "Every JSON line the app wrote, by level. Live from boot: the server logs its configuration as it starts.",
        viz: "bar",
        format: "number",
        query: {
          sourceId,
          logql: `sum by (level) (count_over_time({${APP}} | json | __error__="" [1m]))`,
          minStep: "1m",
        },
        layout: { x: 0, y: 0, w: 6, h: 3 },
      },
      {
        id: "errors-by-route",
        title: "Errors and warnings by route per minute",
        description:
          "Lines at error or warn, by the API route that wrote them. Empty while nothing fails; a request refused or failed adds one.",
        viz: "bar",
        format: "number",
        query: {
          sourceId,
          logql: `sum by (route) (count_over_time({${APP}} | json | level=~"error|warn" [1m]))`,
          minStep: "1m",
        },
        layout: { x: 6, y: 0, w: 6, h: 3 },
      },
      {
        id: "request-p95",
        title: "Request p95 by route (ms)",
        description:
          "95th percentile of the durationMs each completed request logs, per route. A streaming route's is its time to first byte.",
        viz: "line",
        format: "ms",
        query: {
          sourceId,
          logql: `quantile_over_time(0.95, {${APP}} | json | msg="request.completed" | unwrap durationMs [5m]) by (route)`,
        },
        layout: { x: 0, y: 3, w: 6, h: 3 },
      },
      {
        id: "guard-refusals",
        title: "Guard refusals by reason, last hour",
        description:
          "Queries the SQL, PromQL and LogQL guards refused in the last hour, by language and the class of rule. A refused model draft counts as well as a refused panel.",
        viz: "table",
        query: {
          sourceId,
          logql: `sum by (language, reason) (count_over_time({${APP}} | json | msg="guard.refused" [1h]))`,
          instant: true,
        },
        layout: { x: 6, y: 3, w: 6, h: 3 },
      },
      {
        id: "request-log",
        title: "Request log",
        description:
          "One line per API request: method, route, status and duration, newest first. Expand a line for its request id and the rest of its fields.",
        viz: "logs",
        query: {
          sourceId,
          logql: `{${APP}} | json | msg=~"request\\\\.(completed|rejected|failed)" | line_format "{{.method}} {{.route}} {{.status}} {{.durationMs}}ms"`,
        },
        options: { level: "level", limit: 200 },
        layout: { x: 0, y: 6, w: 12, h: 4 },
      },
      {
        id: "error-lines",
        title: "Errors",
        description: "The app's error lines, newest first.",
        viz: "logs",
        query: {
          sourceId,
          logql: `{${APP}} | json | level="error" | line_format "{{.msg}}"`,
        },
        options: { level: "level", limit: 100 },
        layout: { x: 0, y: 10, w: 12, h: 4 },
      },
    ],
  };
}

/** The committed spec, parsed against the current IR. */
export function lokiSelfMonitoringSpec(): Dashboard {
  return parseDashboard(spec());
}
