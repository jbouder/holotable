import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { parser } from "@prometheus-io/lezer-promql";
import { buildPromqlPlan } from "@/lib/promql/plan";
import { type PromqlLimits, validatePromql } from "@/lib/promql/safety";
import {
  CORPUS_CATALOG,
  CORPUS_VARIABLES,
  PROMQL_CORPUS,
} from "./fixtures/promql-corpus";

/**
 * Property-based tests for the PromQL guard (#384), in the shape of
 * `sql-safety.fuzz.test.ts`.
 *
 * Expressions are generated from adversarial shapes: every spelling of a
 * metric name, `__name__` under every operator, `@` in every position and
 * spelling, selectors nested in every function, binary operators between an
 * allowlisted and an unlisted metric, ranges, offsets and subqueries over the
 * bound, comments, and a `:name` in every string position. The generator
 * records why an expression is poisoned. Then:
 *
 *   1. Every poisoned expression is refused.
 *   2. Every benign expression is accepted, so over-refusal fails too.
 *   3. Everything accepted satisfies an independent oracle, which walks the
 *      raw lezer tree itself and shares none of the guard's walk.
 *   4. Every accepted expression's plan, with the variables bound and a
 *      tenant matcher, re-parses, keeps its metrics, and puts the tenant
 *      matcher on every selector, exactly once.
 *
 * Plus: the guard never throws, on any string.
 *
 * `FUZZ_RUNS` and `FUZZ_SEED` as for the SQL suite; a failure prints the
 * expression. Promote it into `test/fixtures/promql-corpus.ts`.
 */

const RUNS = Number.parseInt(process.env.FUZZ_RUNS ?? "", 10) || 300;
const SEED = Number.parseInt(process.env.FUZZ_SEED ?? "", 10) || 20261009;

const LIMITS: PromqlLimits = {
  maxRangeMs: 7 * 86_400_000,
  maxSelectors: 32,
  maxDepth: 64,
  maxSubqueryPoints: 11_000,
};
const ALLOWED = new Set(CORPUS_CATALOG.metrics.map((m) => m.name));

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

const allowedMetric = fc.constantFrom("up", "http_requests_total", "node:cpu:rate5m");
const unlistedMetric = fc.constantFrom(
  "secret_total",
  "up_extra",
  "UP",
  "node_cpu_seconds_total",
);

const benignMatcher = fc.constantFrom(
  'job="api"',
  "job='api'",
  "job=`api`",
  'instance=~"a|b"',
  'status!="500"',
  'route!~"/health.*"',
  'instance=":host"',
  'instance=~":hosts"',
  'job="web:host"',
  'job=""',
);
const poisonMatcher: fc.Arbitrary<Gen> = fc.constantFrom(
  { text: 'instance=":undeclared"', poison: "undeclared variable" },
  { text: '"job"="api"', poison: "quoted label name" },
);

const selector: fc.Arbitrary<Gen> = fc
  .tuple(
    fc.oneof(
      {
        weight: 4,
        arbitrary: allowedMetric.map((m) => ({ m, poison: null as string | null })),
      },
      {
        weight: 1,
        arbitrary: unlistedMetric.map((m) => ({ m, poison: "unlisted metric" })),
      },
    ),
    fc.constantFrom(
      "bare",
      "name",
      "quoted",
      "regexName",
      "negName",
      "nameless",
      "twice",
    ),
    fc.array(
      fc.oneof(
        { weight: 6, arbitrary: benignMatcher.map(clean) },
        { weight: 1, arbitrary: poisonMatcher },
      ),
      { maxLength: 3 },
    ),
    ws,
  )
  .map(([{ m, poison }, spelling, matchers, space]): Gen => {
    const inner = matchers.map((x) => x.text);
    const base = poison ?? poisoned(...matchers);
    const join = (items: string[]) => `{${items.join(`,${space}`)}}`;
    switch (spelling) {
      case "bare":
        return { text: inner.length > 0 ? `${m}${join(inner)}` : m, poison: base };
      case "name":
        return { text: join([`__name__="${m}"`, ...inner]), poison: base };
      case "quoted":
        return { text: join([`"${m}"`, ...inner]), poison: base };
      case "regexName":
        return {
          text: join([`__name__=~"${m}"`, ...inner]),
          poison: "__name__ as a pattern",
        };
      case "negName":
        return { text: join([`__name__!="${m}"`, ...inner]), poison: "__name__ negated" };
      case "nameless":
        return {
          text: join(inner.length > 0 ? inner : ['job="api"']),
          poison: "no metric name",
        };
      default:
        return {
          text: `${m}${join([`__name__="${m}"`, ...inner])}`,
          poison: "metric named twice",
        };
    }
  });

// --- Expressions -------------------------------------------------------------

const range: fc.Arbitrary<Gen> = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom("5m", "1h", "30s", "7d", "1h30m").map(clean) },
  {
    weight: 1,
    arbitrary: fc.constantFrom("8d", "30d", "1y", "2w").map(bad("range over the bound")),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom("5m * 2", "1h + 1m").map(bad("duration arithmetic")),
  },
);

/** An offset: `5m * 2` after one is multiplication, not a duration, so plain ones only. */
const offset: fc.Arbitrary<Gen> = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom("5m", "1h", "-1h", "7d").map(clean) },
  {
    weight: 1,
    arbitrary: fc.constantFrom("8d", "-30d", "1y").map(bad("offset over the bound")),
  },
);

const at = fc.constantFrom(
  "@ start()",
  "@ end()",
  "@ 1609746000",
  "@1609746000.5",
  "@ -1",
);

const leaf: fc.Arbitrary<Gen> = fc.oneof(
  { weight: 4, arbitrary: selector },
  {
    weight: 2,
    arbitrary: fc
      .tuple(
        fc.constantFrom("rate", "increase", "max_over_time", "avg_over_time"),
        selector,
        range,
      )
      .map(([fn, sel, r]) => ({
        text: `${fn}(${sel.text}[${r.text}])`,
        poison: poisoned(sel, r),
      })),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom("vector(1)", "time()", "pi()", "1").map(clean),
  },
);

const expr: fc.Arbitrary<Gen> = fc.letrec<{ e: Gen }>((tie) => ({
  e: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    { weight: 4, arbitrary: leaf },
    {
      weight: 1,
      arbitrary: fc
        .tuple(
          fc.constantFrom("sum", "avg", "max", "count"),
          fc.constantFrom("", " by (job)", " without (instance)"),
          tie("e"),
        )
        .map(([agg, mod, e]) => ({ text: `${agg}${mod} (${e.text})`, poison: e.poison })),
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
            "* on(job) group_left()",
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
      arbitrary: fc
        .tuple(fc.constantFrom("abs", "ceil", "sort", "scalar"), tie("e"))
        .map(([fn, e]) => ({ text: `${fn}(${e.text})`, poison: e.poison })),
    },
    {
      weight: 1,
      arbitrary: tie("e").map((e) => ({ text: `(${e.text})`, poison: e.poison })),
    },
    {
      weight: 1,
      arbitrary: fc.tuple(tie("e"), offset).map(([e, o]) => ({
        text: `(${e.text}) offset ${o.text}`,
        poison: poisoned(e, o),
      })),
    },
    {
      weight: 1,
      arbitrary: fc
        .tuple(tie("e"), fc.constantFrom("1h:5m", "1h:", "1d:1h", "30d:1h", "1h:1ms"))
        .map(([e, sq]) => ({
          text: `max_over_time((${e.text})[${sq}])`,
          poison:
            e.poison ??
            (sq.startsWith("30d")
              ? "subquery over the bound"
              : sq.endsWith("1ms")
                ? "subquery step under 1s"
                : null),
        })),
    },
    {
      weight: 1,
      arbitrary: fc
        .tuple(tie("e"), at)
        .map(([e, a]) => ({ text: `(${e.text}) ${a}`, poison: "@ modifier" })),
    },
    {
      weight: 1,
      arbitrary: fc
        .tuple(selector, at)
        .map(([s, a]) => ({ text: `rate(${s.text}[5m] ${a})`, poison: "@ modifier" })),
    },
    {
      weight: 1,
      arbitrary: fc
        .tuple(tie("e"), fc.constantFrom('"$1"', '":host"', '":hosts"'))
        .map(([e, arg]) => ({
          text: `label_replace(${e.text}, "dst", ${arg}, "job", "(.*)")`,
          poison: e.poison ?? (arg === '"$1"' ? null : "variable outside a matcher"),
        })),
    },
    {
      weight: 1,
      arbitrary: fc
        .tuple(fc.constantFrom("info", "limitk", "first_over_time"), selector)
        .map(([fn, s]) => ({
          text:
            fn === "info"
              ? `info(${s.text})`
              : fn === "limitk"
                ? `limitk(1, ${s.text})`
                : `first_over_time(${s.text}[5m])`,
          poison: "function not allowed",
        })),
    },
    {
      weight: 1,
      arbitrary: tie("e").map((e) => ({ text: `${e.text} # note`, poison: "comment" })),
    },
  ),
})).e;

// --- The oracle ------------------------------------------------------------------

interface Visited {
  name: string;
  text: string;
  parent: string;
  error: boolean;
}

/** Every node, by name, text and parent, walked straight off lezer's cursor. */
function walk(src: string): Visited[] {
  const out: Visited[] = [];
  const cursor = parser.parse(src).cursor();
  const parents: string[] = [];
  for (;;) {
    out.push({
      name: cursor.type.name,
      text: src.slice(cursor.from, cursor.to),
      parent: parents[parents.length - 1] ?? "",
      error: cursor.type.isError,
    });
    if (cursor.firstChild()) {
      parents.push(out[out.length - 1].name);
      continue;
    }
    while (!cursor.nextSibling()) {
      if (!cursor.parent()) return out;
      parents.pop();
    }
  }
}

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3_600,
  d: 86_400,
  w: 604_800,
  y: 31_536_000,
};

/** What must not be in an accepted expression, found without the guard's code. */
function oracleProblems(src: string): string[] {
  const problems: string[] = [];
  for (const n of walk(src)) {
    if (n.error) problems.push("error node");
    if (
      ["At", "StepInvariantExpr", "LineComment", "QuotedLabelMatcher", "Info"].includes(
        n.name,
      )
    ) {
      problems.push(n.name);
    }
    if (
      n.name === "Identifier" &&
      n.parent === "VectorSelector" &&
      !ALLOWED.has(n.text)
    ) {
      problems.push(`metric ${n.text}`);
    }
    if (n.name === "StringLiteral" && n.parent === "QuotedLabelName") {
      if (!ALLOWED.has(n.text.slice(1, -1))) problems.push(`quoted metric ${n.text}`);
    }
    // A selector starts with its name, or its braces name it.
    if (
      n.name === "VectorSelector" &&
      n.text.startsWith("{") &&
      !/^\{\s*("|__name__\s*=\s*")/.test(n.text) &&
      !/__name__\s*=\s*"/.test(n.text)
    ) {
      problems.push(`nameless selector ${n.text}`);
    }
  }
  if (/__name__\s*(=~|!=|!~)/.test(src)) problems.push("__name__ not by equality");
  for (const [, inner] of src.matchAll(/\[([^\]]*)\]/g)) {
    const first = inner.split(":")[0].trim();
    const m = /^(\d+)([smhdwy])$/.exec(first);
    if (m && Number(m[1]) * UNIT_SECONDS[m[2]] > 7 * 86_400)
      problems.push(`range ${first}`);
  }
  return problems;
}

function run<T>(prop: fc.IPropertyWithHooks<T>): void {
  fc.assert(prop, { numRuns: RUNS, seed: SEED, verbose: 1 });
}

const check = (src: string) =>
  validatePromql(src, CORPUS_CATALOG, CORPUS_VARIABLES, LIMITS);

test("the corpus still has its verdicts", () => {
  for (const entry of PROMQL_CORPUS) {
    assert.equal(check(entry.promql).ok, entry.verdict === "accept", entry.note);
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

test("every accepted plan re-parses, keeps its metrics, and filters every selector once", () => {
  const to = new Date("2026-10-09T12:00:00Z");
  const from = new Date(to.getTime() - 3_600_000);
  const metricsOf = (src: string) =>
    walk(src)
      .filter((n) => n.name === "Identifier" && n.parent === "VectorSelector")
      .map((n) => n.text);
  run(
    fc.property(
      expr,
      fc.string({ maxLength: 12 }),
      fc.array(fc.string({ maxLength: 6 }), { minLength: 1, maxLength: 3 }),
      fc.string({ minLength: 1, maxLength: 8 }),
      (g, host, hosts, tenant) => {
        if (!check(g.text).ok) return;
        const plan = buildPromqlPlan({
          promql: g.text,
          from,
          to,
          rowFilter: { label: "tenant", value: tenant },
          variables: { host, hosts },
          limits: LIMITS,
        });
        const before = walk(g.text).filter((n) => n.name === "VectorSelector").length;
        const after = walk(plan.expr);
        assert.ok(!after.some((n) => n.error), `does not parse: ${plan.expr}`);
        assert.equal(
          after.filter((n) => n.name === "VectorSelector").length,
          before,
          plan.expr,
        );
        assert.equal(
          after.filter(
            (n) => n.name === "UnquotedLabelMatcher" && /^tenant\s*=/.test(n.text),
          ).length,
          before,
          plan.expr,
        );
        assert.deepEqual(metricsOf(plan.expr), metricsOf(g.text), plan.expr);
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
    "up",
    "{",
    "}",
    "[",
    "]",
    "(",
    ")",
    '"',
    "'",
    "`",
    "@",
    ":",
    "=~",
    "!=",
    ",",
    "5m",
    " ",
    "offset",
    "\\",
    "#",
    "by",
    "rate",
  ];
  run(
    fc.property(fc.array(fc.constantFrom(...pieces), { maxLength: 30 }), (parts) => {
      assert.equal(typeof check(parts.join("")).ok, "boolean");
    }),
  );
});
