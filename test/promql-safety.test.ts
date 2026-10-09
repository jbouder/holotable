import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMetrics } from "@/lib/metrics";
import { durationMs, plainString, regexLiteral, stringLiteral } from "@/lib/promql/parse";
import { buildLabelValuesPlan, buildPromqlPlan, stepSecondsFor } from "@/lib/promql/plan";
import { applyPromqlRowFilter } from "@/lib/promql/row-filter";
import {
  defaultLimits,
  type PromqlLimits,
  validatePromql,
  validatePromqlLabelValues,
} from "@/lib/promql/safety";
import { bindPromqlVariables } from "@/lib/promql/variables";
import { RowFilterError } from "@/lib/sql/row-filter";
import { VariableError } from "@/lib/sql/variables";
import {
  CORPUS_CATALOG,
  CORPUS_VARIABLES,
  PROMQL_CORPUS,
} from "./fixtures/promql-corpus";

/**
 * The PromQL guard (#384), rule by rule, with the message each refusal
 * carries. The fuzz suite (`promql-safety.fuzz.test.ts`) generates the
 * shapes; this file names them.
 */

const LIMITS: PromqlLimits = {
  maxRangeMs: 7 * 86_400_000,
  maxSelectors: 32,
  maxDepth: 64,
  maxSubqueryPoints: 11_000,
};

function check(promql: string, declared: ReadonlySet<string> = CORPUS_VARIABLES) {
  return validatePromql(promql, CORPUS_CATALOG, declared, LIMITS);
}

function refused(promql: string, reason: string, message: string | RegExp) {
  const result = check(promql);
  assert.equal(result.ok, false, `${promql} was accepted`);
  assert.equal(result.reason, reason, promql);
  if (typeof message === "string") assert.equal(result.error, message, promql);
  else assert.match(result.error ?? "", message, promql);
}

test("the corpus has the verdicts it records", () => {
  for (const entry of PROMQL_CORPUS) {
    const result = check(entry.promql);
    assert.equal(
      result.ok,
      entry.verdict === "accept",
      `${entry.note}: ${JSON.stringify(entry.promql)} → ${result.error ?? "accepted"}`,
    );
  }
});

test("one expression, which parses", () => {
  refused("", "empty", "the query is empty");
  refused("up}}", "structure", "PromQL does not parse at character 3");
  refused("up up", "structure", /^PromQL does not parse at character \d+$/);
  refused("u".repeat(8_001), "bounds", "the query is longer than 8000 characters");
});

test("every selector names exactly one metric, on the allowlist", () => {
  refused(
    "node_cpu_seconds_total",
    "catalog",
    'metric "node_cpu_seconds_total" is not in this source\'s catalog',
  );
  refused('{job="api"}', "catalog", "every selector must name a metric");
  refused(
    '{__name__=~".+"}',
    "catalog",
    '__name__ may only be matched with "=": a pattern could read any metric',
  );
  refused('up{__name__="up"}', "catalog", "a selector names its metric once");
  refused('{"u\\x70"}', "catalog", "a quoted metric name must be a plain string");
  refused('{__name__="u\\x70"}', "catalog", "a __name__ matcher must be a plain string");
  // Both sides of an operator are checked.
  refused(
    "up / node_cpu_seconds_total",
    "catalog",
    'metric "node_cpu_seconds_total" is not in this source\'s catalog',
  );
  // Names are compared exactly; a metric is not its prefix.
  refused("upx", "catalog", 'metric "upx" is not in this source\'s catalog');
});

test("the @ modifier is refused in every spelling: the server owns time", () => {
  for (const promql of [
    "up @ start()",
    "up @ end()",
    "up @ 1609746000",
    "up @ 1609746000.5",
    "rate(up[5m] @ start())",
    "max_over_time(up[1h:5m] @ end())",
    "sum(up @ start())",
    "up offset 5m @ end()",
  ]) {
    refused(
      promql,
      "time",
      "the @ modifier is not allowed: the server owns the time of every query",
    );
  }
});

test("ranges, subqueries and offsets are bounded", () => {
  assert.equal(check("rate(up[7d])").ok, true);
  refused(
    "rate(up[8d])",
    "time",
    "a range of 8d is longer than the 7d this server allows",
  );
  refused(
    "max_over_time(up[30d:1h])",
    "time",
    "a subquery range of 30d is longer than the 7d this server allows",
  );
  refused(
    "up offset 2w",
    "time",
    "an offset of 14d is longer than the 7d this server allows",
  );
  refused(
    "up offset -2w",
    "time",
    "an offset of 14d is longer than the 7d this server allows",
  );
  refused("max_over_time(up[1h:1ms])", "time", "a subquery step must be at least 1s");
  refused(
    "max_over_time(up[7d:1s])",
    "time",
    "a subquery of 7d at 1s evaluates more than 11000 points",
  );
  refused("rate(up[5m * 2])", "structure", '"5m * 2" is not a plain duration');
  // A limit set lower is the limit.
  assert.equal(
    validatePromql("rate(up[2h])", CORPUS_CATALOG, new Set(), {
      ...LIMITS,
      maxRangeMs: 3_600_000,
    }).error,
    "a range of 2h is longer than the 1h this server allows",
  );
});

test("only the stable functions and aggregations, and no comments", () => {
  refused("info(up)", "function", "function info() is not allowed");
  refused(
    "first_over_time(up[5m])",
    "function",
    "function first_over_time() is not allowed",
  );
  refused("limitk(1, up)", "function", "aggregation limitk is not allowed");
  refused("up # note", "structure", "comments are not allowed");
  refused(
    'up{"job"="api"}',
    "structure",
    "quoted label names are not supported in a matcher",
  );
});

test("selectors and nesting are bounded", () => {
  const many = Array.from({ length: 33 }, () => "up").join(" + ");
  refused(many, "bounds", "the query has more than 32 selectors");
  const deep = `${"abs(".repeat(40)}up${")".repeat(40)}`;
  refused(deep, "bounds", "the query nests deeper than 64 levels");
});

test("a variable is a label matcher's whole value, and is declared", () => {
  assert.equal(check('up{instance=":host"}').ok, true);
  refused(
    'up{instance=":nope"}',
    "variable",
    "variable :nope is not declared on this dashboard",
  );
  refused(
    ":host",
    "variable",
    "a variable may appear only as a label matcher's value, not as a metric name",
  );
  refused(
    'label_replace(up, "a", ":host", "instance", "(.*)")',
    "variable",
    ':host may appear only as a label matcher\'s whole value, such as {host=":host"}',
  );
  refused(
    'count_values(":host", up)',
    "variable",
    /^:host may appear only as a label matcher's whole value/,
  );
  // Part of a value is not a reference, and is a plain string like any other.
  assert.equal(check('up{instance="web:host"}').ok, true);
  assert.equal(check('up{instance=":host-1"}').ok, true);
});

test("an unknown label is a hint, never a refusal", () => {
  assert.deepEqual(check('up{bogus="x"}'), {
    ok: true,
    hints: ['up has no label "bogus" in the catalog'],
  });
  assert.deepEqual(check("sum by (nowhere) (up)"), {
    ok: true,
    hints: ['no metric this query reads has a label "nowhere" in the catalog'],
  });
  assert.deepEqual(check('sum by (job) (up{job="x"})'), { ok: true });
});

test("a refusal is counted by its reason, never its message", async () => {
  check("up @ start()");
  const scrape = await renderMetrics();
  assert.match(
    scrape,
    /holotable_promql_validation_rejections_total\{reason="time"\} \d+/,
  );
  assert.doesNotMatch(scrape, /start\(\)/);
});

test("a string literal must be closed, though the grammar's tokenizer allows otherwise", () => {
  refused('"', "structure", "a string at character 1 is not closed");
  refused('up{job="x\\"}', "structure", /PromQL does not parse|is not closed/);
  refused(
    'label_replace(up, "a", "b", "c", "d)',
    "structure",
    /PromQL does not parse|is not closed/,
  );
});

test("the guard never throws, on any string", () => {
  for (const promql of [
    "(",
    ")",
    "{",
    '"',
    "`",
    "[5m]",
    "@",
    "\u0000",
    "up{a=~",
    "-",
    "😀",
  ]) {
    const result = check(promql);
    assert.equal(result.ok, false, promql);
  }
});

/* ------------------------------------------------------------------------- */
/* The literals                                                               */
/* ------------------------------------------------------------------------- */

test("a value is written as an escaped string, and a regex value matches only itself", () => {
  assert.equal(stringLiteral('a"b\\c\nd\u0001'), '"a\\"b\\\\c\\nd\\x01"');
  assert.equal(regexLiteral("a.b|c(d)*"), "a\\.b\\|c\\(d\\)\\*");
  assert.equal(plainString('"plain"'), "plain");
  assert.equal(plainString("`raw\\x`"), "raw\\x");
  assert.equal(plainString('"esc\\x70"'), null);
  assert.equal(durationMs("1h30m"), 5_400_000);
  assert.equal(durationMs("90"), 90_000);
  assert.equal(durationMs("5m2"), null);
});

/* ------------------------------------------------------------------------- */
/* Variables                                                                  */
/* ------------------------------------------------------------------------- */

test("a variable's value enters only as an escaped literal in its matcher", () => {
  assert.equal(
    bindPromqlVariables(
      'up{instance=":host"}',
      { host: 'web-1"} or vector(1) #' },
      LIMITS,
    ),
    'up{instance="web-1\\"} or vector(1) #"}',
  );
  assert.equal(
    bindPromqlVariables('up{instance=~":hosts"}', { hosts: ["a.b", "c|d"] }, LIMITS),
    'up{instance=~"^(a\\\\.b|c\\\\|d)$"}',
  );
  assert.equal(
    bindPromqlVariables('up{instance!~":host"}', { host: "a.b" }, LIMITS),
    'up{instance!~"a\\\\.b"}',
  );
  // A picked value that looks like a reference is a value.
  assert.equal(
    bindPromqlVariables('up{instance=":host"}', { host: ":hosts" }, LIMITS),
    'up{instance=":hosts"}',
  );
});

test("a multi-value pick needs a regex matcher, and every reference needs a value", () => {
  assert.throws(
    () => bindPromqlVariables('up{instance=":hosts"}', { hosts: ["a", "b"] }, LIMITS),
    (err) =>
      err instanceof VariableError &&
      err.message ===
        "variable :hosts takes several values; match it with =~ or !~, not =",
  );
  assert.throws(
    () => bindPromqlVariables('up{instance=":host"}', {}, LIMITS),
    (err) => err instanceof Error && /variable :host is not declared/.test(err.message),
  );
  assert.throws(
    () => bindPromqlVariables('up{instance=~":hosts"}', { hosts: [] }, LIMITS),
    (err) =>
      err instanceof VariableError && err.message === "no value for variable :hosts",
  );
});

/* ------------------------------------------------------------------------- */
/* The tenant matcher                                                         */
/* ------------------------------------------------------------------------- */

const TENANT = { label: "tenant", value: 'acme"\\' };
const TENANT_MATCHER = 'tenant="acme\\"\\\\"';

test("every selector gets the tenant matcher, wherever it is", () => {
  const cases: [string, string][] = [
    ["up", `up{${TENANT_MATCHER}}`],
    ["up{}", `up{${TENANT_MATCHER}}`],
    ['up{job="x"}', `up{job="x", ${TENANT_MATCHER}}`],
    ['up{job="x",}', `up{job="x",${TENANT_MATCHER}}`],
    ['{__name__="up"}', `{__name__="up", ${TENANT_MATCHER}}`],
    ['{"up"}', `{"up", ${TENANT_MATCHER}}`],
    ["rate(up[5m])", `rate(up{${TENANT_MATCHER}}[5m])`],
    ["up offset 5m", `up{${TENANT_MATCHER}} offset 5m`],
    [
      "max_over_time(rate(up[5m])[1h:1m]) / on() group_left sum(up)",
      `max_over_time(rate(up{${TENANT_MATCHER}}[5m])[1h:1m]) / on() group_left sum(up{${TENANT_MATCHER}})`,
    ],
    [
      'label_replace(up, "a", "$1", "instance", "(.*)")',
      `label_replace(up{${TENANT_MATCHER}}, "a", "$1", "instance", "(.*)")`,
    ],
  ];
  for (const [input, output] of cases) {
    assert.equal(applyPromqlRowFilter(input, TENANT, LIMITS), output, input);
  }
});

test("a selector that matches on the tenant label is refused, not overridden", () => {
  for (const promql of ['up{tenant="other"}', 'up{tenant=~".*"}', 'up{tenant!="me"}']) {
    assert.throws(
      () => applyPromqlRowFilter(promql, TENANT, LIMITS),
      (err) =>
        err instanceof RowFilterError &&
        err.message ===
          'this source filters by "tenant" itself; remove that matcher from the query',
      promql,
    );
  }
  assert.throws(() =>
    applyPromqlRowFilter("up", { label: "__name__", value: "x" }, LIMITS),
  );
});

/* ------------------------------------------------------------------------- */
/* The plan                                                                   */
/* ------------------------------------------------------------------------- */

const TO = new Date("2026-10-09T12:00:00Z");
const FROM = new Date(TO.getTime() - 3_600_000);

test("the plan binds the variables, then the tenant, and takes its time from the server", () => {
  const plan = buildPromqlPlan({
    promql: ' sum(rate(http_requests_total{host=":host"}[5m])) ',
    from: FROM,
    to: TO,
    rowFilter: { label: "tenant", value: "acme" },
    variables: { host: "web-1" },
    limits: LIMITS,
  });
  assert.equal(plan.instant, false);
  if (plan.instant) return;
  assert.equal(
    plan.expr,
    'sum(rate(http_requests_total{host="web-1", tenant="acme"}[5m]))',
  );
  assert.equal(plan.start, FROM);
  assert.equal(plan.end, TO);
  assert.equal(plan.stepSeconds, stepSecondsFor(FROM, TO));
  assert.ok(plan.timeoutMs > 0);
});

test("an instant plan asks for one time, the end of the window", () => {
  const plan = buildPromqlPlan({
    promql: "up",
    instant: true,
    from: FROM,
    to: TO,
    rowFilter: null,
    limits: LIMITS,
  });
  assert.deepEqual(plan, {
    instant: true,
    expr: "up",
    time: TO,
    timeoutMs: plan.timeoutMs,
  });
});

test("the step covers the window in the points a browser keeps, raised by minStep", () => {
  const day = new Date(TO.getTime() - 86_400_000);
  assert.equal(stepSecondsFor(day, TO), 120); // 86,400 s over the default 720 points
  assert.equal(stepSecondsFor(FROM, TO), 5);
  assert.equal(stepSecondsFor(FROM, TO, "1m"), 60);
  assert.equal(stepSecondsFor(FROM, TO, "1s"), 5);
  assert.equal(stepSecondsFor(TO, TO), 1);
});

test("the default limits are the configured ones", () => {
  assert.equal(defaultLimits().maxRangeMs, 7 * 86_400_000);
});

/* ------------------------------------------------------------------------- */
/* Label-values variables                                                     */
/* ------------------------------------------------------------------------- */

test("a label-values match is one allowlisted selector and nothing more", () => {
  const ok = (match?: string) =>
    validatePromqlLabelValues({ label: "instance", match }, CORPUS_CATALOG, LIMITS);
  assert.equal(ok().ok, true);
  assert.equal(ok('up{job="api"}').ok, true);
  assert.equal(
    ok("secret_total").error,
    'metric "secret_total" is not in this source\'s catalog',
  );
  for (const match of ["rate(up[5m])", "up + up", "up[5m]", "sum(up)"]) {
    assert.equal(
      ok(match).error,
      'a label-values match is one series selector, such as up{job="api"}',
      match,
    );
  }
  assert.equal(ok('up{job=":host"}').ok, false);
  assert.equal(
    validatePromqlLabelValues({ label: "not a label" }, CORPUS_CATALOG, LIMITS).error,
    '"not a label" is not a label name',
  );
});

test("label values come from the allowlist when the variable names no match", () => {
  assert.deepEqual(
    buildLabelValuesPlan({
      label: "instance",
      catalog: { metrics: [{ name: "up" }, { name: "a.b" }] },
      rowFilter: null,
      limits: LIMITS,
    }).match,
    ['{__name__=~"^(up|a\\\\.b)$"}'],
  );
  assert.deepEqual(
    buildLabelValuesPlan({
      label: "instance",
      catalog: { metrics: [{ name: "up" }] },
      rowFilter: { label: "tenant", value: "acme" },
      limits: LIMITS,
    }).match,
    ['{__name__=~"^(up)$", tenant="acme"}'],
  );
  assert.deepEqual(
    buildLabelValuesPlan({
      label: "instance",
      match: 'up{job="api"}',
      catalog: CORPUS_CATALOG,
      rowFilter: { label: "tenant", value: "acme" },
      limits: LIMITS,
    }).match,
    ['up{job="api", tenant="acme"}'],
  );
});
