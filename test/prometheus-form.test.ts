import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyMetricMenu,
  emptyPrometheusFormState,
  isSelected,
  MENU_PAGE,
  needsSecretRef,
  type PrometheusFormState,
  prometheusConfigFromFormState,
  prometheusConfigText,
  prometheusFormStateFromConfig,
  prometheusFormStateFromConfigText,
  searchMenu,
  sharedLabels,
  toggleMetric,
  withLabels,
} from "@/lib/prometheus-form";
import { MAX_METRICS } from "@/lib/sources/kinds/prometheus";

/**
 * The Prometheus source form as data (#386): what config a state describes,
 * where each error lands, the JSON view's round trip, and the menu.
 */

function filled(overrides: Partial<PrometheusFormState> = {}): PrometheusFormState {
  return {
    ...emptyPrometheusFormState(),
    url: " https://prom.example.com ",
    metrics: [
      { name: "up", type: "gauge", labels: ["job", "instance", "tenant"] },
      {
        name: "http_requests_total",
        type: "counter",
        labels: ["job", "route", "tenant"],
      },
    ],
    ...overrides,
  };
}

test("a filled state is a config, trimmed, with the row filter only when it is set", () => {
  const result = prometheusConfigFromFormState(filled());
  assert.ok(result.ok);
  assert.equal(result.config.url, "https://prom.example.com");
  assert.equal(result.config.kind, "prometheus");
  assert.equal(result.config.rowFilter, undefined);

  const tenant = prometheusConfigFromFormState(
    filled({ rowFilterLabel: "tenant", rowFilterClaim: "sub" }),
  );
  assert.ok(tenant.ok);
  assert.deepEqual(tenant.config.rowFilter, { label: "tenant", claim: "sub" });
});

test("each problem lands on its field, in words", () => {
  const empty = prometheusConfigFromFormState(emptyPrometheusFormState());
  assert.equal(empty.ok, false);
  if (empty.ok) return;
  assert.equal(
    empty.errors.url,
    "Enter the endpoint's URL, such as https://prometheus.example.com.",
  );
  assert.equal(empty.errors.metrics, "Select at least one metric for the allowlist.");

  const half = prometheusConfigFromFormState(
    filled({ rowFilterLabel: "__reserved", rowFilterClaim: "" }),
  );
  assert.equal(half.ok, false);
  if (half.ok) return;
  assert.ok(half.errors["rowFilter.label"]);
  assert.ok(half.errors["rowFilter.claim"]);

  const withCreds = prometheusConfigFromFormState(
    filled({ url: "https://u:p@prom.example.com" }),
  );
  assert.equal(withCreds.ok, false);
});

test("the JSON view round-trips, and text that does not parse is reported, not applied", () => {
  const state = filled({ auth: "none", rowFilterLabel: "tenant", rowFilterClaim: "sub" });
  const back = prometheusFormStateFromConfigText(prometheusConfigText(state));
  assert.ok(back.ok);
  assert.deepEqual(back.state, { ...state, url: "https://prom.example.com" });
  assert.deepEqual(prometheusFormStateFromConfigText("{ nope"), {
    ok: false,
    error: "The config is not valid JSON.",
  });
  const wrong = prometheusFormStateFromConfigText(JSON.stringify({ kind: "prometheus" }));
  assert.equal(wrong.ok, false);
});

test("a stored config loads into the form as it was", () => {
  const result = prometheusConfigFromFormState(
    filled({ rowFilterLabel: "tenant", rowFilterClaim: "sub" }),
  );
  assert.ok(result.ok);
  const state = prometheusFormStateFromConfig(result.config);
  assert.equal(state.rowFilterLabel, "tenant");
  assert.equal(state.metrics.length, 2);
});

test("only the none auth mode goes without a secret_ref", () => {
  assert.equal(needsSecretRef("none"), false);
  assert.equal(needsSecretRef("bearer"), true);
  assert.equal(needsSecretRef("basic"), true);
});

test("the menu is searched by name, type and help, a page at a time", () => {
  const menu = {
    ran: true,
    metrics: [
      { name: "up", type: "gauge" as const, help: "Target is up" },
      { name: "http_requests_total", type: "counter" as const },
      ...Array.from({ length: 80 }, (_, i) => ({
        name: `m_${i}`,
        type: "unknown" as const,
      })),
    ],
  };
  assert.deepEqual(
    searchMenu(menu, "counter").map((m) => m.name),
    ["http_requests_total"],
  );
  assert.deepEqual(
    searchMenu(menu, "TARGET").map((m) => m.name),
    ["up"],
  );
  assert.equal(searchMenu(menu, "").length, MENU_PAGE);
  assert.deepEqual(searchMenu(emptyMetricMenu(), "x"), []);
});

test("ticking adds a metric with no labels yet; discovery fills them; the cap holds", () => {
  let state = emptyPrometheusFormState();
  state = toggleMetric(state, { name: "up", type: "gauge" });
  assert.ok(isSelected(state, "up"));
  assert.deepEqual(state.metrics[0].labels, []);
  state = withLabels(state, { up: ["job"], other: ["x"] });
  assert.deepEqual(state.metrics, [{ name: "up", type: "gauge", labels: ["job"] }]);
  state = toggleMetric(state, { name: "up", type: "gauge" });
  assert.equal(state.metrics.length, 0);

  let full = emptyPrometheusFormState();
  for (let i = 0; i < MAX_METRICS + 5; i++) {
    full = toggleMetric(full, { name: `m${i}`, type: "unknown" });
  }
  assert.equal(full.metrics.length, MAX_METRICS);
});

test("a tenant label's candidates are the labels every selected metric has", () => {
  assert.deepEqual(sharedLabels(filled()), ["job", "tenant"]);
  assert.deepEqual(sharedLabels(emptyPrometheusFormState()), []);
});
