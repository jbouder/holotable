import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrometheusTemplates } from "@/lib/builtin-templates-promql";
import { Panel } from "@/lib/ir";
import { validatePromql } from "@/lib/promql/safety";
import type { PrometheusConfig } from "@/lib/sources/kinds/prometheus";
import { loadSource } from "../scripts/lib/eval";

/**
 * The Prometheus golden signals (#388): built from the allowlist, every
 * expression through the real guard, and a signal only where a metric serves it.
 */

const demo = loadSource("prometheus-demo");
const cfg = demo.config as PrometheusConfig;

function source(config: PrometheusConfig, missing: string[] = []) {
  return { id: "prom", name: "Prom", config, catalogMissingTables: missing };
}

test("every built-in over the demo catalog parses and passes the guard", () => {
  const templates = buildPrometheusTemplates(source(cfg));
  assert.ok(templates.length > 0);
  for (const t of templates) {
    const panels = t.body.kind === "panel" ? [t.body.panel] : t.body.dashboard.panels;
    for (const p of panels) {
      assert.ok(Panel.safeParse(p).success, t.id);
      const query = p.query as { promql: string };
      const check = validatePromql(query.promql, cfg);
      assert.ok(check.ok, `${t.id}: ${check.ok ? "" : check.error}`);
    }
  }
  assert.ok(templates.some((t) => t.id === "builtin:prom:promql:golden-signals"));
});

const base = (metrics: PrometheusConfig["metrics"]): PrometheusConfig => ({
  ...cfg,
  metrics,
});

test("each signal comes from the metric that can serve it", () => {
  const templates = buildPrometheusTemplates(
    source(
      base([
        { name: "http_requests_total", type: "counter", labels: ["code", "job"] },
        { name: "req_duration_seconds_bucket", type: "histogram", labels: ["le"] },
        { name: "queue_depth", type: "gauge", labels: ["job"] },
      ]),
    ),
    "panel",
  );
  const promql = Object.fromEntries(
    templates.map((t) => [
      t.id.split(":").at(-1),
      t.body.kind === "panel" ? (t.body.panel.query as { promql: string }).promql : "",
    ]),
  );
  assert.deepEqual(promql, {
    rate: "sum(rate(http_requests_total[5m]))",
    errors:
      '100 * sum(rate(http_requests_total{code=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))',
    duration:
      "1000 * histogram_quantile(0.95, sum by (le) (rate(req_duration_seconds_bucket[5m])))",
    saturation: "max(queue_depth)",
  });
});

test("a metric missing from the endpoint, or with no plain name, serves nothing", () => {
  const templates = buildPrometheusTemplates(
    source(
      base([
        { name: "gone_total", type: "counter", labels: [] },
        { name: "up", type: "gauge", labels: ["job"] },
      ]),
      ["gone_total"],
    ),
  );
  assert.deepEqual(
    templates.map((t) => t.id),
    ["builtin:prom:promql:saturation"],
  );
});
