import { test } from "node:test";
import assert from "node:assert/strict";
import {
  promqlCompletionContext,
  promqlCompletions,
  promqlDiagnostics,
} from "@/lib/promql/completion";
import { validatePromql } from "@/lib/promql/safety";

/**
 * The PromQL editor (#388): completion from the catalog the editor is sent,
 * the guard's counter hints, and the guard's verdict placed in the text.
 */

const CATALOG = {
  metrics: [
    { name: "up", type: "gauge", labels: ["instance", "job"] },
    {
      name: "http_requests_total",
      type: "counter",
      help: "Requests served.",
      labels: ["code", "job", "route"],
    },
  ],
};

test("at the start of an expression, metrics and functions are offered", () => {
  const found = promqlCompletions(CATALOG, "sum(ht", 6);
  assert.ok(found);
  assert.equal(found.from, 4);
  const http = found.options.find((o) => o.label === "http_requests_total");
  assert.deepEqual(http, {
    label: "http_requests_total",
    type: "variable",
    detail: "counter",
    info: "Requests served.",
  });
  assert.ok(found.options.some((o) => o.label === "rate" && o.type === "function"));
});

test("inside a selector's braces, that metric's labels are offered", () => {
  const text = "http_requests_total{jo";
  const found = promqlCompletions(CATALOG, text, text.length);
  assert.ok(found);
  assert.deepEqual(
    found.options.map((o) => o.label),
    ["code", "job", "route"],
  );
  assert.equal(found.from, text.length - 2);
  // After a comma too.
  const next = 'up{job="a", ';
  assert.deepEqual(
    promqlCompletions(CATALOG, next, next.length)?.options.map((o) => o.label),
    ["instance", "job"],
  );
});

test("a bare selector's braces offer every listed label", () => {
  const found = promqlCompletions(CATALOG, "{", 1);
  assert.deepEqual(
    found?.options.map((o) => o.label),
    ["code", "instance", "job", "route"],
  );
});

test("nothing is offered inside a quoted value or after a matcher's operator", () => {
  assert.deepEqual(promqlCompletionContext('up{job="ap', 10), { kind: "none" });
  assert.equal(promqlCompletions(CATALOG, "up{job=", 7), null);
});

test("the guard hints at rate() over a gauge and at a counter drawn raw", () => {
  const gauge = validatePromql("rate(up[5m])", CATALOG);
  assert.ok(gauge.ok);
  assert.ok(gauge.hints?.some((h) => /rate\(\) over up, a gauge/.test(h)));
  const raw = validatePromql("http_requests_total", CATALOG);
  assert.ok(raw.ok);
  assert.ok(raw.hints?.some((h) => /http_requests_total is a counter/.test(h)));
  const fine = validatePromql("sum(rate(http_requests_total[5m]))", CATALOG);
  assert.ok(fine.ok);
  assert.equal(fine.hints?.length ?? 0, 0);
});

test("a hint is placed on the metric it names, a refusal at its character", () => {
  const text = "rate(up[5m])";
  assert.deepEqual(
    promqlDiagnostics(text, { ok: true, hints: ["rate() over up, a gauge"] }).map((d) => [
      d.from,
      d.to,
      d.severity,
    ]),
    [[5, 7, "warning"]],
  );
  assert.deepEqual(
    promqlDiagnostics(text, {
      ok: false,
      error: "a string at character 3 is not closed",
    }).map((d) => [d.from, d.to, d.severity]),
    [[2, 3, "error"]],
  );
  assert.deepEqual(
    promqlDiagnostics(text, { ok: false, error: "the query is refused" }).map((d) => [
      d.from,
      d.to,
    ]),
    [[0, text.length]],
  );
});
