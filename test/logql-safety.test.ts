import { test } from "node:test";
import assert from "node:assert/strict";
import { logqlDurationMs } from "@/lib/logql/parse";
import { buildLogqlLabelValuesPlan, buildLogqlPlan } from "@/lib/logql/plan";
import { applyLogqlRowFilter } from "@/lib/logql/row-filter";
import {
  defaultLogqlLimits,
  type LogqlLimits,
  LogqlRefusal,
  validateLogql,
  validateLogqlLabelValues,
} from "@/lib/logql/safety";
import { bindLogqlVariables, logqlVariableNames } from "@/lib/logql/variables";
import { renderMetrics } from "@/lib/metrics";
import { stepSecondsFor } from "@/lib/promql/plan";
import { RowFilterError } from "@/lib/sql/row-filter";
import { VariableError } from "@/lib/sql/variables";
import { CORPUS_CATALOG, CORPUS_VARIABLES, LOGQL_CORPUS } from "./fixtures/logql-corpus";

/**
 * The LogQL guard (#561), rule by rule, with the message each refusal
 * carries. The fuzz suite (`logql-safety.fuzz.test.ts`) generates the
 * shapes; this file names them.
 */

const LIMITS: LogqlLimits = {
  maxRangeMs: 7 * 86_400_000,
  maxSelectors: 32,
  maxDepth: 128,
};

function check(logql: string, declared: ReadonlySet<string> = CORPUS_VARIABLES) {
  return validateLogql(logql, CORPUS_CATALOG, declared, LIMITS);
}

function refused(logql: string, reason: string, message: string | RegExp) {
  const result = check(logql);
  assert.equal(result.ok, false, `${logql} was accepted`);
  assert.equal(result.reason, reason, logql);
  if (typeof message === "string") assert.equal(result.error, message, logql);
  else assert.match(result.error ?? "", message, logql);
}

const UNANCHORED =
  'every stream selector needs an "=" matcher with a value on a label this source lists, such as {app="api"}';

test("the corpus has the verdicts it records", () => {
  for (const entry of LOGQL_CORPUS) {
    const result = check(entry.logql);
    assert.equal(
      result.ok,
      entry.verdict === "accept",
      `${entry.note}: ${JSON.stringify(entry.logql)} → ${result.error ?? "accepted"}`,
    );
  }
});

test("one expression, which parses", () => {
  refused("", "empty", "the query is empty");
  refused("{}", "structure", "LogQL does not parse at character 2");
  refused('{app="api"}}', "structure", /^LogQL does not parse at character \d+$/);
  refused('{app="api"} {app="web"}', "structure", /^LogQL does not parse/);
  refused(
    `{app="${"a".repeat(8_000)}"}`,
    "bounds",
    "the query is longer than 8000 characters",
  );
});

test("a log query and a metric query are told apart by the tree", () => {
  assert.equal(check('{app="api"} |= "x"').kind, "log");
  assert.equal(check('({app="api"})').kind, "log");
  assert.equal(check('rate({app="api"}[5m])').kind, "metric");
  assert.equal(check('sum(rate({app="api"}[5m])) > 1').kind, "metric");
  assert.equal(check("vector(1)").kind, "metric");
});

test("every stream selector is anchored on a listed label with = and a value", () => {
  refused('{app=~".*"}', "catalog", UNANCHORED);
  refused('{app=~"api"}', "catalog", UNANCHORED);
  refused('{app!="api"}', "catalog", UNANCHORED);
  refused('{app=""}', "catalog", UNANCHORED);
  refused("{app=``}", "catalog", UNANCHORED);
  refused('{pod="x"}', "catalog", UNANCHORED);
  // Every selector, including the ones in a metric query's operands.
  refused('rate({app="api"}[5m]) / rate({pod="x"}[5m])', "catalog", UNANCHORED);
  refused('sum(count_over_time({app=~"a.*"}[5m]))', "catalog", UNANCHORED);
  // Names are compared exactly.
  refused('{App="api"}', "catalog", UNANCHORED);
  assert.equal(check('{app="api", pod=~".*"}').ok, true);
});

test("an unlisted label in a matcher is a hint, never a refusal", () => {
  assert.deepEqual(check('{app="api", pod="x", node!="y"}'), {
    ok: true,
    kind: "log",
    hints: [
      `no label "pod" in this source's catalog`,
      `no label "node" in this source's catalog`,
    ],
  });
  // A label filter reads parsed fields, which the catalog does not hold.
  assert.deepEqual(check('{app="api"} | json | pod="x"'), { ok: true, kind: "log" });
});

test("only the listed pipeline stages, functions and aggregations, and no comments", () => {
  refused('{app="api"} # note', "structure", "comments are not allowed");
  for (const logql of [
    '{app="api"} |= "a" or "b" != "c" |~ "d" !~ "e" |> "f" !> "g" |= ip("1.2.3.4")',
    '{app="api"} | json | logfmt | unpack | pattern "<x>" | regexp "(?P<x>.)"',
    '{app="api"} | json a="b" | logfmt --strict c | line_format "{{.a}}" | label_format a=b',
    '{app="api"} | keep a | drop b | decolorize | a > 1 | b > 5s | c < 1KB | d = ip("1.1.1.1")',
    'sum_over_time({app="api"} | unwrap bytes(x) [5m])',
    'avg_over_time({app="api"} | unwrap duration(x) [5m])',
    'max_over_time({app="api"} | unwrap duration_seconds(x) [5m])',
  ]) {
    assert.equal(check(logql).ok, true, logql);
  }
  for (const fn of [
    "count_over_time",
    "rate",
    "rate_counter",
    "bytes_over_time",
    "bytes_rate",
    "avg_over_time",
    "sum_over_time",
    "min_over_time",
    "max_over_time",
    "stddev_over_time",
    "stdvar_over_time",
    "first_over_time",
    "last_over_time",
    "absent_over_time",
  ]) {
    assert.equal(check(`${fn}({app="api"}[5m])`).ok, true, fn);
  }
  for (const agg of [
    "sum",
    "avg",
    "count",
    "max",
    "min",
    "stddev",
    "stdvar",
    "sort",
    "sort_desc",
  ]) {
    assert.equal(check(`${agg}(rate({app="api"}[5m]))`).ok, true, agg);
  }
  assert.equal(check('bottomk(3, rate({app="api"}[5m]))').ok, true);
});

test("a stage, function or aggregation the grammar gains is refused until listed", () => {
  // The grammar pinned here has no approximate aggregations; a newer one
  // does, and they would arrive as unknown nodes: refused, by type.
  refused(
    'approx_topk(5, rate({app="api"}[5m]))',
    "structure",
    /^LogQL does not parse|is not supported in a panel query|is not allowed$/,
  );
});

test("a log query cannot stand beside a binary operator", () => {
  refused(
    '{app="api"} + 1',
    "structure",
    "a log query cannot be an operand of a binary operator; wrap it in a range function such as count_over_time",
  );
  refused(
    'rate({app="api"}[5m]) or {app="web"}',
    "structure",
    /^a log query cannot be an operand/,
  );
});

test("ranges and offsets are bounded, and an offset looks back", () => {
  assert.equal(check('rate({app="api"}[7d])').ok, true);
  refused(
    'rate({app="api"}[8d])',
    "time",
    "a range of 8d is longer than the 7d this server allows",
  );
  refused(
    'rate({app="api"}[1w1d])',
    "time",
    "a range of 8d is longer than the 7d this server allows",
  );
  refused(
    'rate({app="api"}[5m] offset 2w)',
    "time",
    "an offset of 14d is longer than the 7d this server allows",
  );
  refused(
    'rate({app="api"}[5m] offset -1h)',
    "time",
    "a negative offset reads past the end of the window: the server owns the time of every query",
  );
  refused('rate({app="api"}[-5m])', "structure", "a range must be longer than zero");
  refused('rate({app="api"}[0s])', "structure", "a range must be longer than zero");
  // A limit set lower is the limit.
  assert.equal(
    validateLogql('rate({app="api"}[2h])', CORPUS_CATALOG, new Set(), {
      ...LIMITS,
      maxRangeMs: 3_600_000,
    }).error,
    "a range of 2h is longer than the 1h this server allows",
  );
});

test("no construct names an absolute time: the grammar has no @, and the guard adds none", () => {
  for (const logql of [
    '{app="api"} @ 1609746000',
    'rate({app="api"}[5m] @ 1609746000)',
    'rate({app="api"}[5m] @ start())',
    'sum(rate({app="api"}[5m])) @ end()',
  ]) {
    refused(logql, "structure", /^LogQL does not parse at character \d+$/);
  }
});

test("selectors and nesting are bounded, and a long pipeline is not a deep one", () => {
  const many = Array.from({ length: 33 }, () => 'rate({app="api"}[5m])').join(" + ");
  refused(many, "bounds", "the query has more than 32 stream selectors");
  const deep = `${"sum(".repeat(70)}rate({app="api"}[5m])${")".repeat(70)}`;
  refused(deep, "bounds", "the query nests deeper than 128 levels");
  const long = `{app="api"}${' |= "x"'.repeat(150)}${" | json".repeat(150)}`;
  assert.equal(check(long).ok, true);
});

test("a string must be closed, and a matcher must be a label, an operator and a string", () => {
  refused('{app="api"} |= "x', "structure", /does not parse|is not closed/);
  refused('{app="a\\"}', "structure", /does not parse|is not closed/);
});

test("a variable is a matcher's whole value or a line filter's string, and is declared", () => {
  for (const logql of [
    '{app="api", env=":env"}',
    '{app="api", env!=":env"}',
    '{app="api"} |= ":needle"',
    '{app="api"} != ":needle"',
    '{app="api"} | json | level=":env"',
  ]) {
    assert.equal(check(logql).ok, true, logql);
  }
  refused(
    '{app="api", env=":nope"}',
    "variable",
    "variable :nope is not declared on this dashboard",
  );
  refused(
    '{app="api", :env="x"}',
    "variable",
    "a variable may appear only as a value, not as a label name or a field",
  );
  refused(
    '{app="api"} | line_format ":env"',
    "variable",
    ':env may appear only as a matcher\'s whole value, such as {env=":env"}, or as a line filter\'s string, such as |= ":env"',
  );
  for (const logql of [
    '{app="api"} |= "x" or ":needle"',
    '{app="api"} |= ip(":needle")',
    'label_replace(rate({app="api"}[5m]), "a", ":env", "b", "(.*)")',
    '{app="api"} | json x=":env"',
    '{app="api"} | label_format a=":env"',
    '{app="api"} | keep a=":env"',
  ]) {
    refused(logql, "variable", /may appear only as a matcher's whole value/);
  }
  // Part of a value is not a reference, and is a plain string like any other.
  assert.equal(check('{app="api"} |~ "web:env"').ok, true);
  assert.equal(check('{app="api"} |~ ":env-1"').ok, true);
});

test("a slot is decided by the tree, not by how the text looks", () => {
  // Fuzz counterexample #1: it reads as `| keep a, b` then a `!=` line
  // filter, but the grammar continues the keep list with a matcher, and a
  // keep matcher is no variable slot.
  refused(
    '{app="api"} | keep a, b != ":needle"',
    "variable",
    /^:needle may appear only as a matcher's whole value/,
  );
  assert.equal(check('{app="api"} | keep a, b="c" != ":needle"').ok, true);
});

test("a variable never reaches a regex or a pattern", () => {
  const message = (name: string) =>
    `:${name} cannot be used inside a regex or a pattern: a value there could change what the expression is`;
  for (const logql of [
    '{app="api"} |~ ":needle"',
    '{app="api"} !~ ":needle"',
    '{app="api"} |> ":needle"',
    '{app="api"} !> ":needle"',
    '{app="api"} |~ "x" or ":needle"',
  ]) {
    refused(logql, "variable", message("needle"));
  }
  for (const logql of [
    '{app=~":env"}',
    '{app="api", env!~":env"}',
    '{app="api"} | regexp ":env"',
    '{app="api"} | pattern ":env"',
    '{app="api"} | json | level=~":env"',
  ]) {
    refused(logql, "variable", message("env"));
  }
});

test("a refusal is counted by its reason, never its message", async () => {
  check('{app="api"} | regexp ":env"');
  check('{secret_label="x"}');
  const scrape = await renderMetrics();
  assert.match(
    scrape,
    /holotable_logql_validation_rejections_total\{reason="variable"\} \d+/,
  );
  assert.match(
    scrape,
    /holotable_logql_validation_rejections_total\{reason="catalog"\} \d+/,
  );
  assert.doesNotMatch(scrape, /secret_label/);
});

test("the guard never throws, on any string", () => {
  for (const logql of [
    "(",
    ")",
    "{",
    '"',
    "`",
    "[5m]",
    "|",
    "|=",
    "\u0000",
    "{a=~",
    "-",
    "😀",
  ]) {
    assert.equal(check(logql).ok, false, logql);
  }
});

test("durations follow the grammar's units, signed", () => {
  assert.equal(logqlDurationMs("1h30m"), 5_400_000);
  assert.equal(logqlDurationMs("1.5h"), 5_400_000);
  assert.equal(logqlDurationMs("250ms"), 250);
  assert.equal(logqlDurationMs("1m1ms"), 60_001);
  assert.equal(logqlDurationMs("-1h"), -3_600_000);
  assert.equal(logqlDurationMs("5"), null);
  assert.equal(logqlDurationMs("5x"), null);
  assert.equal(logqlDurationMs(""), null);
});

/* ------------------------------------------------------------------------- */
/* Variables                                                                  */
/* ------------------------------------------------------------------------- */

test("a variable's value enters only as an escaped literal in its slot", () => {
  assert.equal(
    bindLogqlVariables(
      '{app="api", env=":env"} |= ":needle"',
      { env: 'prod"} |~ ".*', needle: "a\\b\n" },
      LIMITS,
    ),
    '{app="api", env="prod\\"} |~ \\".*"} |= "a\\\\b\\n"',
  );
  // A picked value that looks like a reference is a value.
  assert.equal(
    bindLogqlVariables('{app="api"} |= ":needle"', { needle: ":env" }, LIMITS),
    '{app="api"} |= ":env"',
  );
  assert.deepEqual(
    logqlVariableNames('{app="api", env=":env"} |= ":needle" != ":env"', LIMITS),
    ["env", "needle"],
  );
});

test("a multi-value pick is refused, and every reference needs a value", () => {
  assert.throws(
    () => bindLogqlVariables('{app="api", env=":envs"}', { envs: ["a", "b"] }, LIMITS),
    (err) =>
      err instanceof VariableError &&
      err.message ===
        "variable :envs takes several values; LogQL takes one value where a variable may appear",
  );
  assert.throws(
    () => bindLogqlVariables('{app="api", env=":env"}', {}, LIMITS),
    (err) => err instanceof VariableError && err.message === "no value for variable :env",
  );
});

/* ------------------------------------------------------------------------- */
/* The tenant matcher                                                         */
/* ------------------------------------------------------------------------- */

const TENANT = { label: "tenant", value: 'acme"\\' };
const T = 'tenant="acme\\"\\\\"';

test("every stream selector gets the tenant matcher, wherever it is", () => {
  const cases: [string, string][] = [
    ['{app="api"}', `{app="api", ${T}}`],
    ['{app="api" , env="x"}', `{app="api" , env="x", ${T}}`],
    ['{app="api"} |= "x" | json', `{app="api", ${T}} |= "x" | json`],
    ['({app="api"})', `({app="api", ${T}})`],
    ['rate({app="api"}[5m] offset 1h)', `rate({app="api", ${T}}[5m] offset 1h)`],
    ['rate(({app="api"})[5m])', `rate(({app="api", ${T}})[5m])`],
    [
      'sum by (route) (rate({app="api"} | json | status >= 500 [5m]))',
      `sum by (route) (rate({app="api", ${T}} | json | status >= 500 [5m]))`,
    ],
    [
      'sum(rate({app="api"}[5m])) / on(x) group_left sum(count_over_time({env="prod"} |= "e" [1h]))',
      `sum(rate({app="api", ${T}}[5m])) / on(x) group_left sum(count_over_time({env="prod", ${T}} |= "e" [1h]))`,
    ],
    [
      'label_replace(rate({app="api"}[5m]), "a", "$1", "b", "(.*)") > 1 and rate({app="web"}[5m])',
      `label_replace(rate({app="api", ${T}}[5m]), "a", "$1", "b", "(.*)") > 1 and rate({app="web", ${T}}[5m])`,
    ],
  ];
  for (const [input, output] of cases) {
    assert.equal(
      applyLogqlRowFilter(input, TENANT, CORPUS_CATALOG, LIMITS),
      output,
      input,
    );
  }
  // A label filter on the tenant label later in the pipeline only narrows.
  assert.equal(
    applyLogqlRowFilter(
      '{app="api"} | json | tenant="other"',
      TENANT,
      CORPUS_CATALOG,
      LIMITS,
    ),
    `{app="api", ${T}} | json | tenant="other"`,
  );
});

test("a selector that matches on the tenant label is refused, not overridden", () => {
  for (const logql of ['{app="api", tenant="other"}', '{app="api", tenant=~".*"}']) {
    assert.throws(
      () => applyLogqlRowFilter(logql, TENANT, CORPUS_CATALOG, LIMITS),
      (err) =>
        err instanceof RowFilterError &&
        err.message ===
          'this source filters by "tenant" itself; remove that matcher from the query',
      logql,
    );
  }
});

test("the row filter's label must be listed, a label name, and given a value", () => {
  assert.throws(
    () =>
      applyLogqlRowFilter(
        '{app="api"}',
        { label: "org", value: "x" },
        CORPUS_CATALOG,
        LIMITS,
      ),
    (err) =>
      err instanceof RowFilterError &&
      err.message === 'this source filters by "org", which its catalog does not list',
  );
  assert.throws(
    () =>
      applyLogqlRowFilter(
        '{app="api"}',
        { label: "tenant", value: "" },
        CORPUS_CATALOG,
        LIMITS,
      ),
    (err) =>
      err instanceof RowFilterError && err.message === 'no value to filter "tenant" by',
  );
  assert.throws(() =>
    applyLogqlRowFilter(
      '{app="api"}',
      { label: "__tenant", value: "x" },
      { labels: [{ name: "__tenant" }] },
      LIMITS,
    ),
  );
});

/* ------------------------------------------------------------------------- */
/* The plan                                                                   */
/* ------------------------------------------------------------------------- */

const TO = new Date("2026-10-09T12:00:00Z");
const FROM = new Date(TO.getTime() - 3_600_000);

test("a log plan binds the variables, then the tenant, and reads the newest lines of the window", () => {
  const plan = buildLogqlPlan({
    logql: ' {app="api", env=":env"} |= ":needle" ',
    from: FROM,
    to: TO,
    catalog: CORPUS_CATALOG,
    rowFilter: { label: "tenant", value: "acme" },
    variables: { env: "prod", needle: "error" },
    limits: LIMITS,
  });
  assert.equal(plan.kind, "log");
  if (plan.kind !== "log") return;
  assert.equal(plan.expr, '{app="api", env="prod", tenant="acme"} |= "error"');
  assert.equal(plan.start.getTime(), FROM.getTime());
  assert.equal(plan.end.getTime(), TO.getTime());
  assert.equal(plan.direction, "backward");
  assert.ok(plan.limit > 0);
  assert.ok(plan.timeoutMs > 0);
});

test("a metric plan steps and aligns as PromQL's does, or asks for one time", () => {
  const plan = buildLogqlPlan({
    logql: 'sum(rate({app="api"}[5m]))',
    from: new Date("2026-10-09T11:00:07Z"),
    to: new Date("2026-10-09T12:00:07Z"),
    catalog: CORPUS_CATALOG,
    rowFilter: null,
    limits: LIMITS,
  });
  assert.equal(plan.kind === "metric" && !plan.instant, true);
  if (plan.kind !== "metric" || plan.instant) return;
  assert.equal(plan.stepSeconds, stepSecondsFor(FROM, TO));
  assert.equal(plan.start.toISOString(), "2026-10-09T11:00:00.000Z");
  assert.equal(plan.end.toISOString(), "2026-10-09T12:00:00.000Z");
  const instant = buildLogqlPlan({
    logql: 'sum(rate({app="api"}[5m]))',
    instant: true,
    from: FROM,
    to: TO,
    catalog: CORPUS_CATALOG,
    rowFilter: null,
    limits: LIMITS,
  });
  assert.deepEqual(instant, {
    kind: "metric",
    instant: true,
    expr: 'sum(rate({app="api"}[5m]))',
    time: TO,
    timeoutMs: instant.timeoutMs,
  });
});

test("a log query cannot be instant", () => {
  assert.throws(
    () =>
      buildLogqlPlan({
        logql: '{app="api"}',
        instant: true,
        from: FROM,
        to: TO,
        catalog: CORPUS_CATALOG,
        rowFilter: null,
        limits: LIMITS,
      }),
    LogqlRefusal,
  );
});

test("a bound value that empties a selector's only anchor is refused", () => {
  assert.throws(
    () =>
      buildLogqlPlan({
        logql: '{env=":env"}',
        from: FROM,
        to: TO,
        catalog: CORPUS_CATALOG,
        rowFilter: { label: "tenant", value: "acme" },
        variables: { env: "" },
        limits: LIMITS,
      }),
    (err) => err instanceof LogqlRefusal && err.message === UNANCHORED,
  );
});

test("the default limits are the configured ones", () => {
  assert.equal(defaultLogqlLimits().maxRangeMs, 7 * 86_400_000);
});

/* ------------------------------------------------------------------------- */
/* Label-values variables                                                     */
/* ------------------------------------------------------------------------- */

test("a label-values query names a listed label, and a match is one anchored selector", () => {
  const ok = (label: string, match?: string) =>
    validateLogqlLabelValues({ label, match }, CORPUS_CATALOG, LIMITS);
  assert.equal(ok("env").ok, true);
  assert.equal(ok("env", '{app="api"}').ok, true);
  assert.equal(ok("pod").error, `label "pod" is not in this source's catalog`);
  assert.equal(ok("not a label").error, '"not a label" is not a label name');
  assert.equal(ok("env", '{app=~".*"}').error, UNANCHORED);
  for (const match of ['{app="api"} |= "x"', 'rate({app="api"}[5m])', '({app="api"})']) {
    assert.equal(
      ok("env", match).error,
      'a label-values match is one stream selector, such as {app="api"}',
      match,
    );
  }
  assert.equal(ok("env", '{app="api", env=":env"}').ok, false);
});

test("label values are narrowed to the tenant, with or without a match", () => {
  const plan = (
    match: string | undefined,
    rowFilter: { label: string; value: string } | null,
  ) =>
    buildLogqlLabelValuesPlan({
      label: "env",
      match,
      catalog: CORPUS_CATALOG,
      rowFilter,
      limits: LIMITS,
    }).query;
  assert.equal(plan(undefined, null), undefined);
  assert.equal(plan(undefined, { label: "tenant", value: "acme" }), '{tenant="acme"}');
  assert.equal(plan('{app="api"}', null), '{app="api"}');
  assert.equal(
    plan('{app="api"}', { label: "tenant", value: "acme" }),
    '{app="api", tenant="acme"}',
  );
  assert.throws(() => plan(undefined, { label: "org", value: "acme" }), RowFilterError);
});
