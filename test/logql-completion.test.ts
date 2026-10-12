import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOGQL_AGGREGATIONS,
  LOGQL_RANGE_FUNCTIONS,
  LOGQL_STAGES,
  logqlCompletionContext,
  logqlCompletions,
  logqlDiagnostics,
} from "@/lib/logql/completion";
import { validateLogql } from "@/lib/logql/safety";

/**
 * The LogQL editor (#565): completion from the catalog the editor is sent,
 * nothing offered the guard would refuse, and the guard's verdict placed in
 * the text.
 */

const CATALOG = {
  labels: [
    { name: "job", values: ["api", "web/edge"] },
    { name: "level", values: ['say "hi"'] },
    { name: "pod", values: [] },
  ],
};

test("inside a selector's braces, the listed labels are offered", () => {
  const text = "{jo";
  const found = logqlCompletions(CATALOG, text, text.length);
  assert.equal(found?.from, 1);
  assert.deepEqual(
    found?.options.map((o) => o.label),
    ["job", "level", "pod"],
  );
  const next = '{job="api", ';
  assert.equal(logqlCompletionContext(next, next.length).kind, "label");
  // After a label, an operator comes next, not another name.
  assert.equal(logqlCompletionContext("{job ", 5).kind, "none");
});

test("inside a matcher's quotes, that label's values are offered, escaped", () => {
  const text = '{job="we';
  const found = logqlCompletions(CATALOG, text, text.length);
  assert.equal(found?.from, 6);
  assert.deepEqual(
    found?.options.map((o) => [o.label, o.apply]),
    [
      ["api", undefined],
      ["web/edge", undefined],
    ],
  );
  const level = '{job="api", level!="';
  assert.equal(
    logqlCompletions(CATALOG, level, level.length)?.options[0].apply,
    'say \\"hi\\"',
  );
  // A regex matcher gets the value as a regex that matches only itself.
  const regex = '{job=~"';
  const dotted = logqlCompletions(
    { labels: [{ name: "job", values: ["a.b"] }] },
    regex,
    regex.length,
  );
  assert.equal(dotted?.options[0].apply, "a\\\\.b");
  // A pipeline label filter is a matcher too.
  const filter = '{job="api"} | job="';
  assert.equal(logqlCompletionContext(filter, filter.length).kind, "value");
});

test("a label with no known values, or a string that is no matcher, offers nothing", () => {
  const pod = '{pod="';
  assert.equal(logqlCompletions(CATALOG, pod, pod.length), null);
  for (const text of [
    '{job="api"} |= "',
    '{job="api"} != "',
    '{job="api"} | line_format "',
  ]) {
    assert.equal(logqlCompletionContext(text, text.length).kind, "none", text);
  }
});

test("after a pipe, the stages and the labels are offered", () => {
  const text = '{job="api"} | js';
  const found = logqlCompletions(CATALOG, text, text.length);
  assert.equal(found?.from, text.length - 2);
  assert.ok(found?.options.some((o) => o.label === "json" && o.type === "keyword"));
  assert.ok(found?.options.some((o) => o.label === "level" && o.type === "property"));
});

test("in a grouping, labels; where an expression starts, functions", () => {
  const by = "sum by (jo";
  assert.equal(logqlCompletionContext(by, by.length).kind, "label");
  const start = "sum(cou";
  const found = logqlCompletions(CATALOG, start, start.length);
  assert.equal(found?.from, 4);
  assert.ok(found?.options.some((o) => o.label === "count_over_time"));
  assert.equal(logqlCompletionContext("", 0).kind, "expression");
});

test("every function, aggregation and stage offered passes the guard", () => {
  const catalog = { labels: [{ name: "job", values: ["api"] }] };
  const selector = '{job="api"}';
  for (const f of LOGQL_RANGE_FUNCTIONS) {
    const expr =
      f === "quantile_over_time"
        ? `${f}(0.9, ${selector} | unwrap n [5m])`
        : f.endsWith("_over_time") && !["count_over_time", "absent_over_time"].includes(f)
          ? `${f}(${selector} | unwrap n [5m])`
          : `${f}(${selector} [5m])`;
    assert.equal(validateLogql(expr, catalog).ok, true, expr);
  }
  for (const f of LOGQL_AGGREGATIONS) {
    const inner = `count_over_time(${selector} [5m])`;
    const expr =
      f === "topk" || f === "bottomk"
        ? `${f}(3, ${inner})`
        : f === "label_replace"
          ? `label_replace(${inner}, "a", "$1", "job", "(.*)")`
          : f === "vector"
            ? "vector(1)"
            : `${f}(${inner})`;
    // `vector(1)` has no selector, which the guard refuses for its anchor, not its function.
    const result = validateLogql(expr, catalog);
    assert.ok(result.ok || /selector|anchor/i.test(result.error ?? ""), expr);
  }
  const stages: Record<string, string> = {
    decolorize: "decolorize",
    drop: "drop pod",
    json: "json",
    keep: "keep pod",
    label_format: 'label_format a="{{.job}}"',
    line_format: 'line_format "{{.job}}"',
    logfmt: "logfmt",
    pattern: 'pattern "<a> <b>"',
    regexp: 'regexp "(?P<a>\\\\w+)"',
    unpack: "unpack",
    unwrap: "unwrap n",
  };
  for (const s of LOGQL_STAGES) {
    const expr =
      s === "unwrap"
        ? `sum_over_time(${selector} | ${stages[s]} [5m])`
        : `${selector} | ${stages[s]}`;
    assert.equal(validateLogql(expr, catalog).ok, true, expr);
  }
});

test("the guard's verdict is placed where it points", () => {
  const text = '{job="api"} |= "x';
  const [unclosed] = logqlDiagnostics(text, {
    ok: false,
    error: "a string at character 16 is not closed",
  });
  assert.deepEqual([unclosed.from, unclosed.to, unclosed.severity], [15, 16, "error"]);

  const hinted = '{job="api", pod="a"}';
  const [hint] = logqlDiagnostics(hinted, {
    ok: true,
    hints: ['label "pod" is not in this source\'s catalog'],
  });
  assert.deepEqual([hint.from, hint.to, hint.severity], [12, 15, "warning"]);

  const [whole] = logqlDiagnostics("{x}", { ok: false, error: "no." });
  assert.deepEqual([whole.from, whole.to], [0, 3]);
});
