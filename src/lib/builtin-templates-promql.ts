import { type Panel, SPEC_VERSION, type ValueFormat } from "@/lib/ir";
import type { PrometheusConfig, PrometheusMetric } from "@/lib/sources/kinds/prometheus";
import type { Template, TemplateKind } from "@/lib/templates";

/**
 * The built-in golden signals for a Prometheus source (#388), the PromQL
 * counterpart of `src/lib/builtin-templates.ts`: parameterized by the
 * source's own allowlist, so a signal appears only when a metric can serve it.
 *
 * - **Rate**: a counter's per-second rate.
 * - **Errors**: the share of a counter's rate whose status or code label is
 *   a 5xx, when one carries such a label; else a counter named for errors.
 * - **Duration**: a histogram's p95 from its `_bucket` series.
 * - **Saturation**: a gauge's maximum across its series.
 *
 * Every name is from the allowlist and must be a plain metric name, so it is
 * written bare rather than escaped. No expression carries a range of its own
 * beyond the `[5m]` a rate needs; the server owns the window and the step. A
 * template is applied through the same picker, guard and save as any other.
 */

/** A metric name the guard reads as a bare selector. */
const PLAIN = /^[A-Za-z_:][A-Za-z0-9_:]*$/;
/** The `_count` and `_sum` of a histogram or summary: counters, but not traffic. */
const AGGREGATE_PART = /_(count|sum)$/;
const ERRORS_NAME = /error|fail/i;
const STATUS_LABELS = ["code", "status", "status_code"];

type Signal = "rate" | "errors" | "duration" | "saturation";
const SIGNALS: Signal[] = ["rate", "errors", "duration", "saturation"];

interface Built {
  panel: Panel;
  /** The metric it reads, for the template's name. */
  label: string;
}

function usable(cfg: PrometheusConfig, missing: readonly string[]): PrometheusMetric[] {
  return cfg.metrics.filter((m) => PLAIN.test(m.name) && !missing.includes(m.name));
}

function panel(
  id: Signal,
  sourceId: string,
  title: string,
  description: string,
  promql: string,
  format?: ValueFormat,
): Panel {
  return {
    id,
    title,
    description,
    viz: "line",
    ...(format ? { format } : {}),
    query: { sourceId, promql },
    layout: { x: 0, y: 0, w: 6, h: 4 },
  };
}

function signalPanel(
  signal: Signal,
  metrics: PrometheusMetric[],
  sourceId: string,
): Built | null {
  const counters = metrics.filter(
    (m) => m.type === "counter" && !AGGREGATE_PART.test(m.name),
  );
  switch (signal) {
    case "rate": {
      const c = counters.find((m) => !ERRORS_NAME.test(m.name));
      if (!c) return null;
      return {
        label: c.name,
        panel: panel(
          "rate",
          sourceId,
          `${c.name} rate`,
          `${c.name} per second, summed over its series.`,
          `sum(rate(${c.name}[5m]))`,
          "number",
        ),
      };
    }
    case "errors": {
      for (const c of counters) {
        const status = STATUS_LABELS.find((l) => c.labels.includes(l));
        if (status) {
          return {
            label: c.name,
            panel: panel(
              "errors",
              sourceId,
              `${c.name} 5xx share`,
              `The share of ${c.name} whose ${status} label is a 5xx, in percent.`,
              `100 * sum(rate(${c.name}{${status}=~"5.."}[5m])) / sum(rate(${c.name}[5m]))`,
              "percent",
            ),
          };
        }
      }
      const named = counters.find((m) => ERRORS_NAME.test(m.name));
      if (!named) return null;
      return {
        label: named.name,
        panel: panel(
          "errors",
          sourceId,
          `${named.name} rate`,
          `${named.name} per second, summed over its series.`,
          `sum(rate(${named.name}[5m]))`,
          "number",
        ),
      };
    }
    case "duration": {
      const h = metrics.find((m) => m.type === "histogram" && m.name.endsWith("_bucket"));
      if (!h) return null;
      const family = h.name.slice(0, -"_bucket".length);
      const seconds = /_seconds$/.test(family);
      const quantile = `histogram_quantile(0.95, sum by (le) (rate(${h.name}[5m])))`;
      return {
        label: family,
        panel: panel(
          "duration",
          sourceId,
          `p95 ${family}`,
          `The 95th percentile of ${family}, from its histogram buckets.`,
          seconds ? `1000 * ${quantile}` : quantile,
          seconds ? "ms" : "number",
        ),
      };
    }
    case "saturation": {
      const g = metrics.find((m) => m.type === "gauge");
      if (!g) return null;
      return {
        label: g.name,
        panel: panel(
          "saturation",
          sourceId,
          `${g.name} (max)`,
          `The highest ${g.name} across its series.`,
          `max(${g.name})`,
        ),
      };
    }
  }
}

/** Two-up, in signal order, like the SQL built-ins. */
function arrange(panels: Panel[]): Panel[] {
  return panels.map((p, i) => ({
    ...p,
    layout: { ...p.layout, x: (i % 2) * 6, y: Math.floor(i / 2) * 4 },
  }));
}

/**
 * A panel template per signal the allowlist can serve, and a golden-signals
 * dashboard when it can serve more than one. Deterministic.
 */
export function buildPrometheusTemplates(
  source: {
    id: string;
    name: string;
    config: PrometheusConfig;
    catalogMissingTables: readonly string[];
  },
  kind?: TemplateKind,
): Template[] {
  const metrics = usable(source.config, source.catalogMissingTables);
  const built = SIGNALS.map((signal) => ({
    signal,
    built: signalPanel(signal, metrics, source.id),
  })).filter((s): s is { signal: Signal; built: Built } => s.built !== null);

  const out: Template[] = [];
  if (kind !== "dashboard") {
    for (const { signal, built: b } of built) {
      out.push({
        id: `builtin:${source.id}:promql:${signal}`,
        origin: "builtin",
        kind: "panel",
        name: `${signal[0].toUpperCase()}${signal.slice(1)} — ${b.label}`,
        description: b.panel.description,
        body: { kind: "panel", specVersion: SPEC_VERSION, panel: b.panel },
      });
    }
  }
  if (kind !== "panel" && built.length > 1) {
    out.push({
      id: `builtin:${source.id}:promql:golden-signals`,
      origin: "builtin",
      kind: "dashboard",
      name: `Golden signals — ${source.name}`,
      description: `Rate, errors, duration and saturation from ${source.name}'s metrics, as far as its allowlist supports them.`,
      body: {
        kind: "dashboard",
        dashboard: {
          specVersion: SPEC_VERSION,
          title: `${source.name} golden signals`,
          timeRange: { from: "now-1h", to: "now" },
          refreshIntervalMs: 30_000,
          panels: arrange(built.map((s) => s.built.panel)),
        },
      },
    });
  }
  return out;
}
