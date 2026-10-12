import assert from "node:assert/strict";
import { test } from "node:test";
import { parser } from "@grafana/lezer-logql";
import fc from "fast-check";
import { buildLogqlPlan } from "@/lib/logql/plan";
import { type LogqlLimits, validateLogql } from "@/lib/logql/safety";
import { CORPUS_CATALOG, CORPUS_VARIABLES, LOGQL_CORPUS } from "./fixtures/logql-corpus";

/**
 * Property-based tests for the LogQL guard (#561), in the shape of
 * `promql-safety.fuzz.test.ts`.
 *
 * Expressions are generated from adversarial shapes: selectors anchored and
 * not (regex-only, negated, empty, on unlisted labels), every pipeline stage
 * with a `:name` in every string position, range functions with ranges and
 * offsets over the bound or negative, aggregations, binary operators between
 * metric queries and with a log query beside one, comments, and functions the
 * grammar does not have. The generator records why an expression is
 * poisoned. Then:
 *
 *   1. Every poisoned expression is refused.
 *   2. Every benign expression is accepted, so over-refusal fails too.
 *   3. Everything accepted satisfies an independent oracle, which walks the
 *      raw lezer tree itself and shares none of the guard's walk.
 *   4. Every accepted expression's plan, with the variables bound and a
 *      tenant matcher, re-parses, keeps its kind and its selectors, and puts
 *      the tenant matcher on every selector, exactly once.
 *
 * Plus: the guard never throws, on any string.
 *
 * `FUZZ_RUNS` and `FUZZ_SEED` as for the SQL suite; a failure prints the
 * expression. Promote it into `test/fixtures/logql-corpus.ts`.
 */

const RUNS = Number.parseInt(process.env.FUZZ_RUNS ?? "", 10) || 300;
const SEED = Number.parseInt(process.env.FUZZ_SEED ?? "", 10) || 20261011;

const LIMITS: LogqlLimits = {
  maxRangeMs: 7 * 86_400_000,
  maxSelectors: 32,
  maxDepth: 128,
};
const LISTED = new Set(CORPUS_CATALOG.labels.map((l) => l.name));

interface Gen {
  text: string;
  /** Why the expression must be refused, or null when it must be accepted. */
  poison: string | null;
}

const poisoned = (...parts: Gen[]): string | null =>
  parts.map((p) => p.poison).find((p) => p !== null) ?? null;

const clean = (text: string): Gen => ({ text, poison: null });
const bad =
  (why: string) =>
  (text: string): Gen => ({ text, poison: why });

const ws = fc.constantFrom("", " ", "  ", "\n", "\t");

// --- Selectors -------------------------------------------------------------

/** A matcher that anchors a selector: `=`, a listed label, a value. */
const anchor = fc.constantFrom(
  'app="api"',
  'env="prod"',
  "namespace=`kube`",
  'env=":env"',
  'app="a\\"b"',
);
/** Matchers that are fine beside an anchor but anchor nothing themselves. */
const loose = fc.constantFrom(
  'pod="x"',
  'app=~"api|web"',
  'env!="dev"',
  'namespace!~"kube-.*"',
  'env=""',
  'pod=~".*"',
  'env!=":env"',
  'app=~"a.*"',
);
const poisonMatcher: fc.Arbitrary<Gen> = fc.constantFrom(
  { text: 'env=":nope"', poison: "undeclared variable" },
  { text: 'env=~":env"', poison: "variable in a regex matcher" },
  { text: 'env!~":env"', poison: "variable in a regex matcher" },
  { text: ':env="x"', poison: "variable as a label name" },
);

const selector: fc.Arbitrary<Gen> = fc
  .tuple(
    fc.option(anchor, { freq: 6 }),
    fc.array(
      fc.oneof(
        { weight: 8, arbitrary: loose.map(clean) },
        { weight: 1, arbitrary: poisonMatcher },
      ),
      { maxLength: 3 },
    ),
    fc.nat(),
    ws,
  )
  .map(([first, rest, at, space]): Gen => {
    const items = rest.map((r) => r.text);
    if (first !== null) items.splice(at % (items.length + 1), 0, first);
    if (items.length === 0) items.push('app=~".+"');
    return {
      text: `{${items.join(`,${space}`)}}`,
      poison: poisoned(...rest) ?? (first === null ? "unanchored selector" : null),
    };
  });

// --- Pipelines ---------------------------------------------------------------

const benignStage = fc.constantFrom(
  '|= "error"',
  '!= "debug"',
  '|~ "a|b"',
  '!~ "c+"',
  '|> "<_> x"',
  '!> "y"',
  '|= ip("10.0.0.0/8")',
  '|= ":needle"',
  '!= ":needle"',
  '|= "a" or "b"',
  '|~ "web:needle"',
  "| json",
  "| logfmt",
  "| logfmt --strict",
  "| unpack",
  '| pattern "<_> <x>"',
  '| regexp "(?P<x>\\\\w+)"',
  '| json a="b.c"',
  '| level="error"',
  '| level!=":env"',
  "| status >= 500",
  "| latency > 5s",
  "| size <= 1KB",
  '| addr = ip("1.2.3.4")',
  '| line_format "{{.msg}}"',
  '| label_format a=b, c="{{.d}}"',
  // Not `| keep a, b`: a `!=` filter after it continues the list as a
  // matcher, `b != ":needle"`, which is not a variable slot (corpus #1).
  '| keep a, b="c"',
  '| drop c, d=~"e"',
  "| decolorize",
);
const poisonStage: fc.Arbitrary<Gen> = fc.constantFrom(
  { text: '|~ ":needle"', poison: "variable in a regex filter" },
  { text: '!~ ":needle"', poison: "variable in a regex filter" },
  { text: '|> ":needle"', poison: "variable in a pattern filter" },
  { text: '| regexp ":env"', poison: "variable as a regexp" },
  { text: '| pattern ":env"', poison: "variable as a pattern" },
  { text: '|= ":nope"', poison: "undeclared variable" },
  { text: '| line_format ":env"', poison: "variable outside a slot" },
  { text: '|= "a" or ":needle"', poison: "variable in an or alternative" },
  { text: '|~ "a" or ":needle"', poison: "variable in a regex alternative" },
  { text: '| json x=":env"', poison: "variable as a json path" },
  { text: '|= ip(":needle")', poison: "variable as an ip() argument" },
  { text: '| level=~":env"', poison: "variable in a regex label filter" },
);

const pipeline: fc.Arbitrary<Gen> = fc
  .array(
    fc.oneof(
      { weight: 10, arbitrary: benignStage.map(clean) },
      { weight: 1, arbitrary: poisonStage },
    ),
    { maxLength: 4 },
  )
  .map((stages) => ({
    text: stages.map((s) => s.text).join(" "),
    poison: poisoned(...stages),
  }));

const logQuery: fc.Arbitrary<Gen> = fc
  .tuple(selector, pipeline, fc.boolean())
  .map(([s, p, paren]) => {
    const body = p.text === "" ? s.text : `${s.text} ${p.text}`;
    // `( … )` around a log query holds a selector, not a pipeline.
    const text = paren && p.text === "" ? `(${body})` : body;
    return { text, poison: poisoned(s, p) };
  });

// --- Metric queries ---------------------------------------------------------

const range: fc.Arbitrary<Gen> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc
      .constantFrom("5m", "1h", "30s", "7d", "1h30m", "1.5h", "250ms")
      .map(clean),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom("8d", "30d", "1y", "2w").map(bad("range over the bound")),
  },
  { weight: 1, arbitrary: fc.constantFrom("-5m", "0s").map(bad("range not positive")) },
);

const offset: fc.Arbitrary<Gen> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.constantFrom("", " offset 5m", " offset 1h", " offset 7d").map(clean),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom(" offset 8d", " offset 1y")
      .map(bad("offset over the bound")),
  },
  { weight: 1, arbitrary: fc.constantFrom(" offset -1h").map(bad("negative offset")) },
);

const unwrap = fc.constantFrom(
  "| unwrap latency",
  "| unwrap duration(latency)",
  "| unwrap duration_seconds(latency)",
  "| unwrap bytes(size) | size > 1",
);

const rangeLeaf: fc.Arbitrary<Gen> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc
      .tuple(
        fc.constantFrom(
          "count_over_time",
          "rate",
          "bytes_rate",
          "bytes_over_time",
          "absent_over_time",
        ),
        selector,
        pipeline,
        range,
        offset,
      )
      .map(([fn, s, p, r, o]) => ({
        text: `${fn}(${s.text}${p.text === "" ? "" : ` ${p.text}`} [${r.text}]${o.text})`,
        poison: poisoned(s, p, r, o),
      })),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(
        fc.constantFrom(
          "sum_over_time",
          "avg_over_time",
          "max_over_time",
          "min_over_time",
          "rate_counter",
          "first_over_time",
          "last_over_time",
          "stddev_over_time",
          "quantile_over_time",
        ),
        selector,
        pipeline,
        unwrap,
        range,
      )
      .map(([fn, s, p, u, r]) => ({
        text: `${fn}(${fn === "quantile_over_time" ? "0.99, " : ""}${s.text}${
          p.text === "" ? "" : ` ${p.text}`
        } ${u} [${r.text}])`,
        poison: poisoned(s, p, r),
      })),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom("vector(1)", "1", "-2.5").map(clean),
  },
  {
    weight: 1,
    arbitrary: fc
      .tuple(
        fc.constantFrom("irate", "histogram_quantile", "approx_topk", "limitk"),
        selector,
      )
      .map(([fn, s]) => ({
        text: `${fn}(${s.text}[5m])`,
        poison: "function the grammar does not have",
      })),
  },
);

const metric: fc.Arbitrary<Gen> = fc.letrec<{ e: Gen }>((tie) => ({
  e: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    { weight: 4, arbitrary: rangeLeaf },
    {
      weight: 1,
      arbitrary: fc
        .tuple(
          fc.constantFrom("sum", "avg", "max", "count", "stddev"),
          fc.constantFrom("", " by (app)", " without (pod)"),
          tie("e"),
        )
        .map(([agg, mod, e]) => ({ text: `${agg}${mod} (${e.text})`, poison: e.poison })),
    },
    {
      weight: 1,
      arbitrary: fc
        .tuple(
          fc.constantFrom("topk(3, ", "bottomk(2, ", "sort(", "sort_desc("),
          tie("e"),
        )
        .map(([agg, e]) => ({ text: `${agg}${e.text})`, poison: e.poison })),
    },
    {
      weight: 1,
      arbitrary: fc
        .tuple(
          tie("e"),
          fc.constantFrom(
            "+",
            "/",
            "and",
            "or",
            "unless",
            "> bool",
            "* on(app) group_left()",
          ),
          tie("e"),
        )
        .map(([a, op, b]) => ({
          text: `${a.text} ${op} ${b.text}`,
          poison: poisoned(a, b),
        })),
    },
    {
      weight: 1,
      arbitrary: tie("e").map((e) => ({ text: `(${e.text})`, poison: e.poison })),
    },
    {
      weight: 1,
      arbitrary: fc
        .tuple(tie("e"), fc.constantFrom('"$1"', '":env"', '":needle"'))
        .map(([e, arg]) => ({
          text: `label_replace(${e.text}, "dst", ${arg}, "app", "(.*)")`,
          poison: e.poison ?? (arg === '"$1"' ? null : "variable as a function argument"),
        })),
    },
    {
      weight: 1,
      arbitrary: fc
        .tuple(logQuery, fc.constantFrom("+", "or", "/"), tie("e"))
        .map(([l, op, e]) => ({
          text: `${l.text} ${op} ${e.text}`,
          poison: "a log query as an operand",
        })),
    },
  ),
})).e;

const expr: fc.Arbitrary<Gen> = fc
  .tuple(
    fc.oneof({ weight: 1, arbitrary: logQuery }, { weight: 2, arbitrary: metric }),
    fc.oneof(
      { weight: 12, arbitrary: fc.constant(false) },
      { weight: 1, arbitrary: fc.constant(true) },
    ),
  )
  .map(([e, comment]) => (comment ? { text: `${e.text} # note`, poison: "comment" } : e));

// --- The oracle ------------------------------------------------------------------

interface Visited {
  name: string;
  text: string;
  parent: number;
  children: number[];
  error: boolean;
}

/** Every node, by name, text and parent index, walked straight off lezer's cursor. */
function walkRaw(src: string): Visited[] {
  const out: Visited[] = [];
  const cursor = parser.parse(src).cursor();
  const parents: number[] = [];
  for (;;) {
    const index = out.length;
    const parent = parents[parents.length - 1] ?? -1;
    out.push({
      name: cursor.type.name,
      text: src.slice(cursor.from, cursor.to),
      parent,
      children: [],
      error: cursor.type.isError,
    });
    if (parent >= 0) out[parent].children.push(index);
    if (cursor.firstChild()) {
      parents.push(index);
      continue;
    }
    while (!cursor.nextSibling()) {
      if (!cursor.parent()) return out;
      parents.pop();
    }
  }
}

const OK_FUNCTIONS = new Set([
  "count_over_time",
  "rate",
  "rate_counter",
  "bytes_rate",
  "bytes_over_time",
  "absent_over_time",
  "sum_over_time",
  "avg_over_time",
  "max_over_time",
  "min_over_time",
  "first_over_time",
  "last_over_time",
  "stddev_over_time",
  "stdvar_over_time",
  "quantile_over_time",
  "sum",
  "avg",
  "max",
  "min",
  "count",
  "stddev",
  "stdvar",
  "topk",
  "bottomk",
  "sort",
  "sort_desc",
]);

const SECONDS: Record<string, number> = {
  ms: 0.001,
  s: 1,
  m: 60,
  h: 3_600,
  d: 86_400,
  w: 604_800,
  y: 31_536_000,
};

function seconds(duration: string): number {
  let total = 0;
  for (const [, n, unit] of duration.matchAll(/([\d.]+)(ms|s|m|h|d|w|y)/g)) {
    total += Number(n) * SECONDS[unit];
  }
  return total;
}

const VARIABLE = /^"(:[a-z][a-z0-9_]*)"$/;

/** What must not be in an accepted expression, found without the guard's code. */
function oracleProblems(src: string): string[] {
  const problems: string[] = [];
  const all = walkRaw(src);
  const kids = (n: Visited) => n.children.map((i) => all[i]);
  for (const n of all) {
    if (n.error) problems.push("error node");
    if (n.name === "LineComment") problems.push("comment");
    if ((n.name === "RangeOp" || n.name === "VectorOp") && !OK_FUNCTIONS.has(n.text)) {
      problems.push(`function ${n.text}`);
    }
    if (n.name === "Selector") {
      // Every Matcher under the braces, the lists unrolled by hand.
      const matchers: Visited[] = [];
      const stack = kids(n);
      while (stack.length > 0) {
        const m = stack.pop() as Visited;
        if (m.name === "Matchers") stack.push(...kids(m));
        else if (m.name === "Matcher") matchers.push(m);
      }
      const anchored = matchers.some((m) => {
        const [label, op, value] = kids(m);
        return LISTED.has(label.text) && op.name === "Eq" && value.text.length > 2;
      });
      if (!anchored) problems.push(`unanchored ${n.text}`);
    }
    if (n.name === "Duration") {
      const parent = all[n.parent];
      if (parent.name === "Range" || parent.name === "OffsetExpr") {
        if (n.text.startsWith("-")) problems.push(`negative ${n.text}`);
        const s = seconds(n.text);
        if (s > 7 * 86_400) problems.push(`duration ${n.text}`);
        if (parent.name === "Range" && s <= 0) problems.push(`empty range ${n.text}`);
      }
    }
    if (n.name === "BinOpExpr") {
      for (const operand of kids(n)) {
        if (operand.name === "Expr" && kids(operand)[0]?.name === "LogExpr") {
          problems.push("log operand");
        }
      }
    }
    const ref = n.name === "String" ? VARIABLE.exec(n.text) : null;
    if (ref) {
      const parent = all[n.parent];
      const siblings = kids(parent);
      const grand = all[parent.parent];
      const inMatcher =
        parent.name === "Matcher" &&
        ["Eq", "Neq"].includes(siblings[1]?.name) &&
        (grand?.name === "Matchers" || grand?.name === "LabelFilter");
      const inLineFilter =
        parent.name === "LineFilter" &&
        siblings[1] === n &&
        ["PipeExact", "Neq"].includes(kids(siblings[0])[0]?.name ?? "");
      if (!inMatcher && !inLineFilter) problems.push(`variable at ${parent.name}`);
      if (!CORPUS_VARIABLES.has(ref[1].slice(1))) problems.push(`undeclared ${ref[1]}`);
    }
    if (n.name === "Identifier" && n.text.startsWith(":"))
      problems.push(`identifier ${n.text}`);
  }
  return problems;
}

function run<T>(prop: fc.IPropertyWithHooks<T>): void {
  fc.assert(prop, { numRuns: RUNS, seed: SEED, verbose: 1 });
}

const check = (src: string) =>
  validateLogql(src, CORPUS_CATALOG, CORPUS_VARIABLES, LIMITS);

test("the corpus still has its verdicts", () => {
  for (const entry of LOGQL_CORPUS) {
    assert.equal(check(entry.logql).ok, entry.verdict === "accept", entry.note);
  }
});

test("every poisoned expression is refused, and every benign one accepted", () => {
  run(
    fc.property(expr, ws, ws, (g, before, after) => {
      const src = `${before}${g.text}${after}`;
      const result = check(src);
      if (g.poison !== null) {
        assert.equal(result.ok, false, `accepted (${g.poison}): ${src}`);
      } else {
        assert.equal(result.ok, true, `refused: ${src}\n  ${result.error}`);
      }
    }),
  );
});

test("everything accepted satisfies the independent oracle", () => {
  run(
    fc.property(expr, (g) => {
      if (!check(g.text).ok) return;
      assert.deepEqual(oracleProblems(g.text), [], g.text);
    }),
  );
});

test("every accepted plan re-parses, keeps its kind and selectors, and filters every selector once", () => {
  const to = new Date("2026-10-11T12:00:00Z");
  const from = new Date(to.getTime() - 3_600_000);
  const top = (src: string) => walkRaw(src)[2]?.name;
  run(
    fc.property(
      expr,
      fc.string({ minLength: 1, maxLength: 12 }).filter((v) => !v.startsWith(":")),
      fc.string({ maxLength: 12 }).filter((v) => !v.startsWith(":")),
      fc.string({ minLength: 1, maxLength: 8 }),
      (g, env, needle, tenant) => {
        const result = check(g.text);
        if (!result.ok) return;
        const plan = buildLogqlPlan({
          logql: g.text,
          from,
          to,
          catalog: CORPUS_CATALOG,
          rowFilter: { label: "tenant", value: tenant },
          variables: { env, needle },
          limits: LIMITS,
        });
        assert.equal(plan.kind, result.kind, plan.expr);
        const before = walkRaw(g.text);
        const after = walkRaw(plan.expr);
        assert.ok(!after.some((n) => n.error), `does not parse: ${plan.expr}`);
        assert.equal(top(plan.expr), top(g.text), plan.expr);
        const selectors = (nodes: Visited[]) =>
          nodes.filter((n) => n.name === "Selector").length;
        assert.equal(selectors(after), selectors(before), plan.expr);
        const tenantMatchers = after.filter(
          (n) =>
            n.name === "Matcher" &&
            after[n.parent].name === "Matchers" &&
            /^tenant\s*=/.test(n.text),
        );
        assert.equal(tenantMatchers.length, selectors(before), plan.expr);
        // The picks never look like references, so none may be left.
        assert.ok(
          !after.some((n) => n.name === "String" && /^":(env|needle)"$/.test(n.text)),
          `a reference survived binding: ${plan.expr}`,
        );
      },
    ),
  );
});

test("the guard never throws, on any string", () => {
  run(
    fc.property(fc.string({ maxLength: 200 }), (s) => {
      assert.equal(typeof check(s).ok, "boolean");
    }),
  );
  const pieces = [
    '{app="api"}',
    "{",
    "}",
    "[",
    "]",
    "(",
    ")",
    '"',
    "`",
    "@",
    ":",
    "=~",
    "!=",
    "|=",
    "|~",
    "|",
    ",",
    "5m",
    " ",
    "offset",
    "\\",
    "#",
    "by",
    "rate",
    "json",
    "unwrap",
    "or",
  ];
  run(
    fc.property(fc.array(fc.constantFrom(...pieces), { maxLength: 30 }), (parts) => {
      assert.equal(typeof check(parts.join("")).ok, "boolean");
    }),
  );
});
