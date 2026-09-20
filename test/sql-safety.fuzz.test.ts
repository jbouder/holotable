import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { parse, scan } from "libpg-query";
import { allowedTables, SourceConfig } from "@/lib/registry";
import { buildExecutablePlan, validateSql } from "@/lib/sql/safety";
import { CORPUS } from "./fixtures/sql-fuzz-corpus";

/**
 * Property-based tests for the SQL guard.
 *
 * The fixed-input suites pin the cases somebody thought of. This one generates
 * statements from a grammar of adversarial *shapes* — forbidden functions under
 * every spelling the lexer accepts, time words under every quoting form, tables
 * hidden in every position a relation can appear, writes smuggled through CTEs,
 * scoping tricks, comments, casing and whitespace — and checks four properties:
 *
 *   1. Every generated statement that contains something the guard must not let
 *      through (it is "poisoned", and the generator says why) is rejected.
 *   2. Everything the guard accepts satisfies an independent oracle: it parses
 *      as exactly one SELECT with no other statement type, locking clause,
 *      parameter, INTO, value keyword, comment or time word anywhere in the
 *      tree, and every relation it reads is allowlisted or a CTE it defines.
 *      The oracle walks the raw parse tree itself; it shares the parser with
 *      the guard but none of the walk in `src/lib/sql/ast.ts`.
 *   3. Every generated statement with nothing poisoned in it is accepted, so an
 *      over-rejection is a failure too.
 *   4. For every accepted statement, the plan `buildExecutablePlan` wraps it in
 *      still parses as one SELECT reading the same relations, with exactly the
 *      two bound parameters the server adds.
 *
 * Plus: the guard never throws, on any string.
 *
 * Runs are deterministic. `FUZZ_RUNS` sets the iteration count per property
 * (CI's long job raises it), `FUZZ_SEED` the seed, and a failure prints the
 * exact statement together with a `FUZZ_SEED=… FUZZ_PATH=…` line that replays
 * it. Promote a counterexample into `test/fixtures/sql-fuzz-corpus.ts` and a
 * named test.
 */

// --- Configuration -------------------------------------------------------------

const RUNS = Number.parseInt(process.env.FUZZ_RUNS ?? "", 10) || 300;
const SEED = Number.parseInt(process.env.FUZZ_SEED ?? "", 10) || 20260920;
const PATH = process.env.FUZZ_PATH;

const source = SourceConfig.parse({
  host: "postgres",
  port: 5432,
  database: "holotable",
  schema: "metrics",
  ssl: false,
  tables: [
    {
      name: "http_requests",
      timeField: "ts",
      columns: [
        { name: "ts", type: "timestamp with time zone" },
        { name: "status", type: "smallint" },
        { name: "duration_ms", type: "double precision" },
      ],
    },
    {
      name: "cpu_usage",
      timeField: "ts",
      columns: [
        { name: "ts", type: "timestamp with time zone" },
        { name: "host", type: "text" },
        { name: "pct", type: "double precision" },
      ],
    },
  ],
});
const allow = allowedTables(source);

function run<T>(prop: fc.IAsyncPropertyWithHooks<T>, numRuns = RUNS): Promise<void> {
  return fc.assert(prop, {
    numRuns,
    seed: SEED,
    path: PATH,
    endOnFailure: PATH !== undefined,
    asyncReporter: async (out) => {
      if (!out.failed) return;
      throw new Error(
        `${fc.defaultReportMessage(out)}\n\nReplay just this case with:\n  FUZZ_SEED=${out.seed} FUZZ_PATH="${out.counterexamplePath}" npm run test:fuzz\n`,
      );
    },
  });
}

// --- Fragments -------------------------------------------------------------------
//
// A fragment is a list of tokens plus, when the fragment contains something the
// guard must reject, the reason. Tokens are joined with generated whitespace
// at the very end, so every quoted thing — a literal, a quoted identifier, a
// dollar-quoted body — is a single token and survives the join untouched.

interface Frag {
  toks: string[];
  poison: string | null;
}

const ok = (...toks: string[]): Frag => ({ toks, poison: null });
const bad = (poison: string, ...toks: string[]): Frag => ({ toks, poison });

function seq(...parts: Array<Frag | string>): Frag {
  const toks: string[] = [];
  let poison: string | null = null;
  for (const part of parts) {
    if (typeof part === "string") {
      toks.push(part);
    } else {
      toks.push(...part.toks);
      poison ??= part.poison;
    }
  }
  return { toks, poison };
}

type Piece = fc.Arbitrary<Frag | string> | Frag | string;

/** Concatenate pieces in order; a bare string is a literal token, a fragment is itself. */
function tup(...pieces: Piece[]): fc.Arbitrary<Frag> {
  const arbs = pieces.map((p) => (p instanceof fc.Arbitrary ? p : fc.constant(p)));
  return fc.tuple(...arbs).map((parts) => seq(...parts));
}

const nothing = fc.constant(ok());

/** `arb` or nothing, weighted `present : absent`. */
function opt(arb: fc.Arbitrary<Frag>, present = 1, absent = 1): fc.Arbitrary<Frag> {
  return fc.oneof(
    { arbitrary: nothing, weight: absent },
    { arbitrary: arb, weight: present },
  );
}

function pick(...frags: Frag[]): fc.Arbitrary<Frag> {
  return fc.constantFrom(...frags);
}

/** `U&"…"` with the first character written as a unicode escape. */
function uescaped(name: string): string {
  const hex = name.charCodeAt(0).toString(16).padStart(4, "0");
  return `U&"\\${hex}${name.slice(1)}"`;
}

// --- Relations -------------------------------------------------------------------

interface Rel {
  toks: string[];
  /**
   * The name the server resolves: unquoted parts folded to lowercase, quoted
   * parts as written; `schema.name` when qualified.
   */
  resolved: string;
  qualified: boolean;
}

function relSpellings(name: string, schema = "metrics"): Rel[] {
  const hex = name.charCodeAt(0).toString(16).padStart(4, "0");
  const plain = (toks: string[]): Rel => ({ toks, resolved: name, qualified: false });
  const qual = (toks: string[]): Rel => ({
    toks,
    resolved: `${schema}.${name}`,
    qualified: true,
  });
  return [
    plain([name]),
    plain([name.toUpperCase()]),
    plain([`"${name}"`]),
    plain([uescaped(name)]),
    plain([`U&"!${hex}${name.slice(1)}"`, "UESCAPE '!'"]),
    qual([`${schema}.${name}`]),
    qual([`${schema.toUpperCase()}.${name.toUpperCase()}`]),
    qual([`${schema}."${name}"`]),
    qual([`"${schema}"."${name}"`]),
  ];
}

/**
 * Quoted spellings of an allowlisted name that differ from it only by case.
 * PostgreSQL preserves the case of a quoted identifier, so each of these names
 * a relation the catalog does not declare.
 */
function quotedRecasings(name: string, schema = "metrics"): Rel[] {
  const upper = name.toUpperCase();
  const title = name.charAt(0).toUpperCase() + name.slice(1);
  const hex = upper.charCodeAt(0).toString(16).padStart(4, "0");
  const plain = (toks: string[], resolved: string): Rel => ({
    toks,
    resolved,
    qualified: false,
  });
  const qual = (toks: string[], resolved: string): Rel => ({
    toks,
    resolved,
    qualified: true,
  });
  return [
    plain([`"${upper}"`], upper),
    plain([`"${title}"`], title),
    plain([`U&"\\${hex}${upper.slice(1)}"`], upper),
    qual([`${schema}."${upper}"`], `${schema}.${upper}`),
    qual([`"${schema.toUpperCase()}".${name}`], `${schema.toUpperCase()}.${name}`),
    qual([`"${schema}"."${title}"`], `${schema}.${title}`),
  ];
}

const ALLOWED_RELS: Rel[] = [
  ...relSpellings("http_requests"),
  ...relSpellings("cpu_usage"),
];

const FORBIDDEN_RELS: Rel[] = [
  ...relSpellings("secret"),
  ...relSpellings("pg_shadow", "pg_catalog"),
  // Allowlisted names, quoted in a case the catalog does not declare.
  ...quotedRecasings("http_requests"),
  ...quotedRecasings("cpu_usage"),
  { toks: ["pg_authid"], resolved: "pg_authid", qualified: false },
  {
    toks: ["information_schema.tables"],
    resolved: "information_schema.tables",
    qualified: true,
  },
  // Off by one character from an allowlisted name.
  { toks: ['"http_requests "'], resolved: "http_requests ", qualified: false },
  { toks: ["http_requestz"], resolved: "http_requestz", qualified: false },
  { toks: ['"http_requests2"'], resolved: "http_requests2", qualified: false },
  { toks: ["httρ_requests"], resolved: "httρ_requests", qualified: false },
  // Right name, wrong schema.
  { toks: ["public.http_requests"], resolved: "public.http_requests", qualified: true },
];

/** Names a WITH clause may define. Two collide with real tables on purpose. */
const CTE_NAMES = ["c0", "c1", "secret", "http_requests"];

type Scope = readonly string[];

/**
 * What the recursive generators know: the CTE names in scope, and whether this
 * statement is allowed to contain poison at all. Benign statements are built
 * from benign leaves only; hostile statements draw poison leaves with a
 * modest weight and are labelled by what they actually contain. Deciding this
 * once per statement keeps the benign/poisoned split near even, where letting
 * every leaf roll independently would poison nearly everything.
 */
interface Ctx {
  scope: Scope;
  hostile: boolean;
}

/**
 * A relation reference, labelled for the scope it appears in. An unqualified
 * name that a CTE in scope defines is that CTE whatever table it looks like.
 */
function relationArb({ scope, hostile }: Ctx): fc.Arbitrary<Frag> {
  const fromRel = (rel: Rel, forbidden: boolean): Frag => {
    const isCte = !rel.qualified && scope.includes(rel.resolved);
    if (isCte || !forbidden) return ok(...rel.toks);
    return bad(`table not in allowlist: ${rel.resolved}`, ...rel.toks);
  };
  const cte = scope.length > 0 ? [fc.constantFrom(...scope).map((n) => ok(n))] : [];
  const poison = hostile
    ? [
        {
          arbitrary: fc.constantFrom(...FORBIDDEN_RELS).map((r) => fromRel(r, true)),
          weight: 4,
        },
        {
          arbitrary: fc.constant(
            bad("catalog-qualified table reference", "holotable.metrics.http_requests"),
          ),
          weight: 1,
        },
      ]
    : [];
  return fc.oneof(
    {
      arbitrary: fc.constantFrom(...ALLOWED_RELS).map((r) => fromRel(r, false)),
      weight: 12,
    },
    ...poison,
    ...cte.map((arbitrary) => ({ arbitrary, weight: 4 })),
  );
}

// --- Functions -------------------------------------------------------------------

/** Forbidden calls, with an argument list that parses. All are on the guard's lists. */
const FORBIDDEN_CALLS: Array<[string, string]> = [
  ["pg_sleep", "(1)"],
  ["pg_read_file", "('/etc/passwd')"],
  ["pg_ls_dir", "('/')"],
  ["dblink", "('dbname=x', 'select 1')"],
  ["query_to_xml", "('select 1', true, false, '')"],
  ["current_setting", "('is_superuser')"],
  ["set_config", "('x.y', '1', false)"],
  ["version", "()"],
  ["pg_terminate_backend", "(1)"],
  ["nextval", "('s')"],
  ["lo_import", "('/etc/passwd')"],
  ["pg_notify", "('c', 'p')"],
  ["pg_advisory_lock", "(1)"],
  // Time and non-determinism.
  ["now", "()"],
  ["clock_timestamp", "()"],
  ["statement_timestamp", "()"],
  ["transaction_timestamp", "()"],
  ["timeofday", "()"],
  ["random", "()"],
  ["gen_random_uuid", "()"],
  ["age", "(ts)"],
];

/** What the oracle looks for. Must cover every name in FORBIDDEN_CALLS. */
const ORACLE_FUNCTIONS = new Set(FORBIDDEN_CALLS.map(([name]) => name));

function fnSpellings(name: string): string[] {
  const mixed = name
    .split("")
    .map((c, i) => (i % 2 ? c.toUpperCase() : c))
    .join("");
  return [
    name,
    name.toUpperCase(),
    mixed,
    `pg_catalog.${name}`,
    `PG_CATALOG."${name}"`,
    `"${name}"`,
    uescaped(name),
  ];
}

const forbiddenCall: fc.Arbitrary<Frag> = fc
  .constantFrom(...FORBIDDEN_CALLS)
  .chain(([name, args]) =>
    fc
      .constantFrom(...fnSpellings(name))
      .map((spelled) => bad(`forbidden function ${name}`, spelled, args)),
  );

// --- Time words and value keywords -------------------------------------------------

const timeKeyword: fc.Arbitrary<Frag> = fc
  .constantFrom(
    "current_timestamp",
    "current_date",
    "current_time",
    "localtime",
    "localtimestamp",
    "current_user",
    "session_user",
    "current_role",
    "current_catalog",
    "current_schema",
    "user",
  )
  .map((kw) => bad(`value keyword ${kw}`, kw));

const timeLiteral: fc.Arbitrary<Frag> = fc
  .constantFrom(
    ["'now'"],
    ["'NOW'"],
    ["' today '"],
    ["'yesterday'::date"],
    ["timestamptz 'tomorrow'"],
    ["E'now'"],
    ["$$now$$"],
    ["$q$today$q$"],
    ["U&'now'"],
    ["U&'\\006eow'"],
    ["'to'\n'day'"],
    ["'now'::timestamptz"],
    ["cast('now' as timestamptz)"],
    ["current_timestamp", "(3)"],
  )
  .map((toks) => bad("time word as a literal", ...toks));

// --- Benign leaves ---------------------------------------------------------------

const benignLiteral: fc.Arbitrary<Frag> = fc
  .constantFrom(
    "'2024-01-01'",
    "'2024-01-01T00:00:00Z'::timestamptz",
    "'epoch'::timestamptz",
    "'infinity'::timestamptz",
    "'--'",
    "';'",
    "'/* x */'",
    "$$ DROP TABLE http_requests $$",
    "$$;--$$",
    "$body$ INSERT INTO t VALUES (1) $body$",
    "E'\\\\n'",
    "'it''s'",
    "U&'\\0041'",
    "B'1010'",
    "X'FF'",
    "1.5e3",
    "-1",
    "NULL",
    "true",
    "interval '1 hour'",
    "date '2024-01-01'",
    "ARRAY[1, 2]",
    "'{\"a\":1}'::jsonb",
  )
  .map((tok) => ok(tok));

const benignScalar: fc.Arbitrary<Frag> = fc
  .constantFrom(
    ["ts"],
    ["status"],
    ["duration_ms"],
    ["host"],
    ["count(*)"],
    ["avg(duration_ms)"],
    ["time_bucket('1 minute', ts)"],
    ["date_trunc('hour', ts)"],
    ["extract(epoch FROM ts)"],
    ["status::text"],
    ["CAST(status AS int)"],
    ["coalesce(status, 0)"],
    ["nullif(status, 0)"],
    ["greatest(status, 1)"],
    ["CASE WHEN status >= 500 THEN 1 ELSE 0 END"],
    ["row_number() OVER (ORDER BY ts)"],
    ["count(*) FILTER (WHERE status = 200)"],
    ["percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)"],
    ["string_agg(status::text, ',')"],
    ["ts + interval '1 hour'"],
    ["ts AT TIME ZONE 'UTC'"],
    ["to_char(ts, 'HH24')"],
    ["status = ANY(ARRAY[200, 201])"],
    ["status BETWEEN 200 AND 299"],
    ["status IS DISTINCT FROM 1"],
    ["host ILIKE 'web%'"],
    ["jsonb_build_object('a', status)"],
    ["'{\"a\":1}'::jsonb -> 'a'"],
    ["lower(host)"],
    ["md5(host)"],
    ["1 + 1"],
    ["-duration_ms"],
    ["generate_series(1, 3)"],
    ["unnest(ARRAY[1, 2])"],
    [
      "sum(duration_ms) OVER (PARTITION BY status ORDER BY ts ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)",
    ],
  )
  .map((toks) => ok(...toks));

const unsupportedConstruct: fc.Arbitrary<Frag> = fc.constantFrom(
  bad("unsupported construct DEFAULT", "DEFAULT"),
  bad("unsupported construct MERGE_ACTION", "MERGE_ACTION()"),
  bad("positional parameter", "$1"),
);

// --- Expressions, conditions, selects --------------------------------------------

type Weighted = Array<{ arbitrary: fc.Arbitrary<Frag>; weight: number }>;

function exprArb(depth: number, ctx: Ctx): fc.Arbitrary<Frag> {
  const leaves: Weighted = [
    { arbitrary: benignScalar, weight: 10 },
    { arbitrary: benignLiteral, weight: 4 },
  ];
  if (ctx.hostile) {
    leaves.push(
      { arbitrary: forbiddenCall, weight: 4 },
      { arbitrary: timeKeyword, weight: 1 },
      { arbitrary: timeLiteral, weight: 2 },
      { arbitrary: unsupportedConstruct, weight: 1 },
    );
  }
  if (depth <= 0) return fc.oneof(...leaves);
  const sub = selectArb(depth - 1, ctx);
  const operand = tup("(", exprArb(depth - 1, ctx), ")");
  return fc.oneof(
    ...leaves,
    { arbitrary: tup("(", sub, ")"), weight: 2 },
    { arbitrary: tup("ARRAY", "(", sub, ")"), weight: 1 },
    { arbitrary: tup(operand, fc.constantFrom("+", "-", "*", "||"), operand), weight: 1 },
  );
}

function condArb(depth: number, ctx: Ctx): fc.Arbitrary<Frag> {
  const leaves: Weighted = [
    {
      arbitrary: pick(
        ok("status = 200"),
        ok("ts > '2024-01-01'"),
        ok("true"),
        ok("host IS NOT NULL"),
      ),
      weight: 6,
    },
    {
      arbitrary: tup(
        "ts",
        fc.constantFrom(">", "<", ">=", "<=", "="),
        "(",
        exprArb(0, ctx),
        ")",
      ),
      weight: 4,
    },
    { arbitrary: tup("duration_ms", ">", "(", exprArb(depth, ctx), ")"), weight: 2 },
  ];
  if (depth <= 0) return fc.oneof(...leaves);
  const sub = selectArb(depth - 1, ctx);
  const operand = tup("(", condArb(depth - 1, ctx), ")");
  return fc.oneof(
    ...leaves,
    { arbitrary: tup("EXISTS", "(", sub, ")"), weight: 2 },
    {
      arbitrary: tup("status", fc.constantFrom("IN", "NOT IN"), "(", sub, ")"),
      weight: 2,
    },
    {
      arbitrary: tup(
        "status",
        fc.constantFrom("=", ">"),
        fc.constantFrom("ANY", "ALL"),
        "(",
        sub,
        ")",
      ),
      weight: 1,
    },
    { arbitrary: tup(operand, fc.constantFrom("AND", "OR"), operand), weight: 2 },
    { arbitrary: tup("NOT", operand), weight: 1 },
  );
}

const alias: fc.Arbitrary<Frag> = opt(
  pick(ok("AS", "h"), ok("h"), ok("AS", "c"), ok('"T"')),
);

function fromItemArb(depth: number, ctx: Ctx): fc.Arbitrary<Frag> {
  const rel = relationArb(ctx);
  const items: Weighted = [
    { arbitrary: tup(rel, alias), weight: 16 },
    { arbitrary: tup("ONLY", rel), weight: 1 },
    { arbitrary: tup(rel, "*"), weight: 1 },
    { arbitrary: tup(rel, "TABLESAMPLE SYSTEM (10)"), weight: 1 },
    {
      arbitrary: pick(
        ok("generate_series(1, 3)", "g(n)"),
        ok("unnest(ARRAY[1, 2])", "WITH ORDINALITY"),
        ok("ROWS FROM (generate_series(1, 2), generate_series(3, 4))", "AS r(a, b)"),
      ),
      weight: 2,
    },
  ];
  if (ctx.hostile) {
    items.push(
      { arbitrary: tup(forbiddenCall, alias), weight: 2 },
      { arbitrary: tup("LATERAL", forbiddenCall, "f"), weight: 1 },
    );
  }
  if (depth <= 0) return fc.oneof(...items);
  const sub = selectArb(depth - 1, ctx);
  return fc.oneof(
    ...items,
    { arbitrary: tup("(", sub, ")", fc.constantFrom("s", "AS s")), weight: 3 },
    { arbitrary: tup("LATERAL", "(", sub, ")", "l"), weight: 2 },
  );
}

function fromArb(depth: number, ctx: Ctx): fc.Arbitrary<Frag> {
  const item = fromItemArb(depth, ctx);
  const join = fc.oneof(
    { arbitrary: tup(",", item), weight: 2 },
    {
      arbitrary: tup(
        fc.constantFrom(
          "JOIN",
          "INNER JOIN",
          "LEFT JOIN",
          "LEFT OUTER JOIN",
          "FULL JOIN",
        ),
        item,
        "ON",
        condArb(depth, ctx),
      ),
      weight: 4,
    },
    {
      arbitrary: tup(fc.constantFrom("JOIN", "LEFT JOIN"), item, "USING (ts)"),
      weight: 2,
    },
    { arbitrary: tup(fc.constantFrom("CROSS JOIN", "NATURAL JOIN"), item), weight: 1 },
  );
  return tup(
    "FROM",
    item,
    fc.array(join, { maxLength: 2 }).map((js) => seq(...js)),
  );
}

/** Join fragments with commas. */
function commaList(frags: Frag[]): Frag {
  const out: Array<Frag | string> = [];
  frags.forEach((f, i) => {
    if (i > 0) out.push(",");
    out.push(f);
  });
  return seq(...out);
}

function targetArb(depth: number, ctx: Ctx): fc.Arbitrary<Frag> {
  const one = fc.oneof(
    { arbitrary: fc.constant(ok("*")), weight: 2 },
    { arbitrary: exprArb(depth, ctx), weight: 6 },
    {
      arbitrary: tup(exprArb(depth, ctx), "AS", fc.constantFrom("v", '"Value"', "c")),
      weight: 3,
    },
  );
  return tup(
    opt(pick(ok("DISTINCT"), ok("DISTINCT ON (status)"), ok("ALL")), 1, 2),
    fc.array(one, { minLength: 1, maxLength: depth > 0 ? 3 : 2 }).map(commaList),
  );
}

/** A data-modifying statement, for smuggling into a CTE. */
const dmlBody: fc.Arbitrary<Frag> = fc.constantFrom(
  bad("INSERT in CTE", "INSERT INTO http_requests VALUES (1) RETURNING *"),
  bad("UPDATE in CTE", "UPDATE http_requests SET status = 1 RETURNING *"),
  bad("DELETE in CTE", "DELETE FROM http_requests RETURNING *"),
  bad(
    "MERGE in CTE",
    "MERGE INTO http_requests USING (SELECT 1) s ON true WHEN MATCHED THEN DELETE RETURNING *",
  ),
);

/** `WITH …` — returns the clause and the names it puts in scope for the body. */
function withArb(depth: number, ctx: Ctx): fc.Arbitrary<{ frag: Frag; scope: Scope }> {
  const { scope, hostile } = ctx;
  return fc
    .tuple(fc.boolean(), fc.shuffledSubarray(CTE_NAMES, { minLength: 1, maxLength: 2 }))
    .chain(([recursive, names]) => {
      const all: Scope = [...scope, ...names];
      const bodies = names.map((name, i) => {
        // PostgreSQL scoping: without RECURSIVE a body sees only the CTEs
        // written before it; with RECURSIVE every body sees every name.
        const visible: Scope = recursive ? all : [...scope, ...names.slice(0, i)];
        const body = fc.oneof(
          { arbitrary: selectArb(depth - 1, { scope: visible, hostile }), weight: 8 },
          ...(hostile ? [{ arbitrary: dmlBody, weight: 1 }] : []),
        );
        return tup(
          name,
          opt(pick(ok("(a)"), ok("(a, b)")), 1, 3),
          "AS",
          opt(pick(ok("MATERIALIZED"), ok("NOT MATERIALIZED")), 1, 3),
          "(",
          body,
          ")",
        );
      });
      const clause = tup(
        "WITH",
        recursive ? "RECURSIVE" : nothing,
        fc.tuple(...bodies).map(commaList),
      );
      return clause.map((frag) => ({ frag, scope: all }));
    });
}

function fixedSelects(ctx: Ctx): fc.Arbitrary<Frag> {
  return fc.oneof(
    pick(
      ok(
        "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 5) SELECT * FROM r",
      ),
      ok("VALUES (1), (2)"),
      ok("SELECT 1"),
    ),
    tup("TABLE", relationArb(ctx)),
  );
}

/** One SELECT (possibly WITH, possibly a set operation), valid for `ctx.scope`. */
function selectArb(depth: number, ctx: Ctx): fc.Arbitrary<Frag> {
  const d = Math.max(depth, 0);
  const { scope, hostile } = ctx;
  const withOrNot: fc.Arbitrary<{ frag: Frag; scope: Scope }> =
    d > 0
      ? fc.oneof(
          { arbitrary: fc.constant({ frag: ok(), scope }), weight: 3 },
          { arbitrary: withArb(d, ctx), weight: 1 },
        )
      : fc.constant({ frag: ok(), scope });

  const simple = withOrNot.chain(({ frag: withClause, scope: innerScope }) => {
    const inner: Ctx = { scope: innerScope, hostile };
    return tup(
      withClause,
      "SELECT",
      targetArb(d, inner),
      opt(fromArb(d, inner), 6),
      opt(tup("WHERE", condArb(d, inner)), 1),
      opt(
        pick(
          ok("GROUP BY 1"),
          ok("GROUP BY status"),
          ok("GROUP BY GROUPING SETS ((status), ())"),
          ok("GROUP BY ROLLUP (status)"),
        ),
        1,
        2,
      ),
      opt(tup("HAVING", condArb(d, inner)), 1, 3),
      opt(
        tup(
          "ORDER BY",
          exprArb(d, inner),
          opt(pick(ok("ASC"), ok("DESC"), ok("DESC NULLS LAST")), 1, 1),
        ),
        1,
        2,
      ),
      opt(
        fc.oneof(
          pick(ok("LIMIT 10"), ok("LIMIT ALL"), ok("FETCH FIRST 5 ROWS ONLY")),
          tup("LIMIT", "(", exprArb(d - 1, inner), ")"),
        ),
        1,
        2,
      ),
      opt(pick(ok("OFFSET 5"), ok("OFFSET 5 ROWS")), 1, 3),
    );
  });

  const leaf = fc.oneof(
    { arbitrary: simple, weight: 8 },
    { arbitrary: fixedSelects(ctx), weight: 1 },
  );
  if (d <= 0) return leaf;

  const arm = tup("(", selectArb(d - 1, ctx), ")");
  const setop = tup(
    arm,
    fc.constantFrom("UNION", "UNION ALL", "INTERSECT", "EXCEPT", "EXCEPT ALL"),
    arm,
    opt(pick(ok("ORDER BY 1"), ok("LIMIT 5")), 1, 1),
  );
  return fc.oneof({ arbitrary: leaf, weight: 5 }, { arbitrary: setop, weight: 1 });
}

// --- Whole statements ------------------------------------------------------------

const DEPTH = 2;

const benignSelect = selectArb(DEPTH, { scope: [], hostile: false });
const hostileSelect = selectArb(DEPTH, { scope: [], hostile: true });

/** Statements that are not a single read-only SELECT, wrapped around a real one. */
const poisonStatement: fc.Arbitrary<Frag> = hostileSelect.chain((sel) =>
  fc.constantFrom(
    bad("INSERT", "INSERT INTO http_requests VALUES (1)"),
    bad("UPDATE", "UPDATE http_requests SET status = 1"),
    bad("DELETE", "DELETE FROM http_requests"),
    bad("TRUNCATE", "TRUNCATE http_requests"),
    bad("DROP", "DROP TABLE http_requests"),
    bad("ALTER", "ALTER TABLE http_requests ADD COLUMN x int"),
    seq(bad("CREATE TABLE AS", "CREATE TABLE t AS"), sel),
    seq(bad("COPY", "COPY", "("), sel, ") TO STDOUT"),
    bad("COPY", "COPY http_requests TO '/tmp/x'"),
    seq(bad("EXPLAIN", "EXPLAIN"), sel),
    seq(bad("EXPLAIN ANALYZE", "EXPLAIN ANALYZE"), sel),
    bad("SHOW", "SHOW search_path"),
    bad("SET", "SET search_path TO public"),
    bad("SET TRANSACTION", "SET TRANSACTION READ WRITE"),
    bad("RESET", "RESET ALL"),
    bad(
      "MERGE",
      "MERGE INTO http_requests USING (SELECT 1) s ON true WHEN MATCHED THEN DELETE",
    ),
    bad("LOCK", "LOCK TABLE http_requests"),
    seq(bad("PREPARE", "PREPARE p AS"), sel),
    bad("EXECUTE", "EXECUTE p"),
    seq(bad("DECLARE CURSOR", "DECLARE c CURSOR FOR"), sel),
    bad("FETCH", "FETCH ALL FROM c"),
    bad("DO", "DO $$ BEGIN END $$"),
    bad("CALL", "CALL f()"),
    bad("VACUUM", "VACUUM http_requests"),
    bad("ANALYZE", "ANALYZE http_requests"),
    bad("GRANT", "GRANT SELECT ON http_requests TO public"),
    bad("BEGIN", "BEGIN"),
    bad("COMMIT", "COMMIT"),
    bad("LISTEN", "LISTEN c"),
    bad("NOTIFY", "NOTIFY c"),
    bad("CREATE FUNCTION", "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'SELECT 1'"),
    bad("SELECT INTO", "SELECT 1 INTO x FROM http_requests"),
    bad("SELECT INTO TEMP", "SELECT 1 INTO TEMP x FROM http_requests"),
    seq(sel, bad("FOR UPDATE", "FOR UPDATE")),
    seq(sel, bad("FOR SHARE", "FOR SHARE SKIP LOCKED")),
    seq(sel, bad("FOR NO KEY UPDATE", "FOR NO KEY UPDATE")),
    seq(sel, bad("FOR KEY SHARE", "FOR KEY SHARE")),
    seq(sel, bad("multiple statements", ";"), sel),
    seq(sel, bad("multiple statements", ";", "SELECT 2")),
    seq(sel, bad("multiple statements", ";", "DELETE FROM http_requests")),
    seq(sel, bad("multiple statements", ";;", "SELECT 2")),
  ),
);

/** A SELECT with a comment spliced between two of its tokens, or at the end. */
const commented: fc.Arbitrary<Frag> = hostileSelect.chain((sel) =>
  fc
    .tuple(
      fc.nat({ max: sel.toks.length }),
      fc.constantFrom(
        "/* x */",
        "/* pg_sleep(1) */",
        "/* a /* nested */ b */",
        "-- x\n",
        "--\n",
      ),
    )
    .map(([at, comment]) => {
      const toks = [...sel.toks];
      // A line comment must be followed by a newline, which its token carries;
      // at the very end it needs none.
      toks.splice(at, 0, at === sel.toks.length ? comment.trimEnd() : comment);
      return { toks, poison: sel.poison ?? `comment ${JSON.stringify(comment)}` };
    }),
);

const statement: fc.Arbitrary<Frag> = fc.oneof(
  { arbitrary: benignSelect, weight: 8 },
  { arbitrary: hostileSelect, weight: 6 },
  { arbitrary: poisonStatement, weight: 2 },
  { arbitrary: commented, weight: 1 },
);

// --- Rendering: casing, whitespace, terminators --------------------------------------

const ws = fc.oneof(
  { arbitrary: fc.constant(" "), weight: 12 },
  { arbitrary: fc.constant("  "), weight: 1 },
  { arbitrary: fc.constant("\t"), weight: 1 },
  { arbitrary: fc.constant("\n"), weight: 2 },
  { arbitrary: fc.constant("\r\n"), weight: 1 },
  { arbitrary: fc.constant(" \n  "), weight: 1 },
);

/** Only bare words are re-cased: anything quoted or dollar-quoted changes meaning. */
function recase(tok: string, mode: number): string {
  if (/['"$\\]/.test(tok)) return tok;
  switch (mode) {
    case 0:
      return tok.toLowerCase();
    case 1:
      return tok.toUpperCase();
    case 2:
      return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
    default:
      return tok;
  }
}

interface Rendered {
  sql: string;
  poison: string | null;
}

function render(frag: Frag): fc.Arbitrary<Rendered> {
  const n = frag.toks.length;
  const mode = fc.constantFrom(0, 1, 2, 3);
  return fc
    .tuple(
      // Casing: one mode for the whole statement, or a mode per token.
      fc.oneof(
        mode.map((m) => Array.from({ length: n }, () => m)),
        fc.array(mode, { minLength: n, maxLength: n }),
      ),
      fc.array(ws, { minLength: Math.max(n - 1, 0), maxLength: Math.max(n - 1, 0) }),
      fc.constantFrom("", "", "", " ", "\n", "\t"),
      fc.constantFrom("", "", "", ";", ";\n", " ;", ";;", "; ;", ";\n;\t"),
    )
    .map(([modes, gaps, lead, trail]) => {
      let sql = lead;
      frag.toks.forEach((tok, i) => {
        if (i > 0) sql += gaps[i - 1];
        sql += recase(tok, modes[i]);
      });
      return { sql: sql + trail, poison: frag.poison };
    });
}

const rendered: fc.Arbitrary<Rendered> = statement.chain(render);
const poisoned = rendered.filter((r) => r.poison !== null);
const benign = rendered.filter((r) => r.poison === null);

// --- The oracle --------------------------------------------------------------------
//
// Independent of `src/lib/sql/ast.ts`: it walks the raw parse tree as JSON and
// resolves CTE names without scope (any name defined anywhere counts), which
// is *more* lenient than the guard. The scoping rules are covered by labelled
// poison instead.

const TIME_WORDS = new Set(["now", "today", "tomorrow", "yesterday"]);

interface OracleOptions {
  /** How many `$N` parameters are expected (the server's time bounds). */
  params: number;
}

async function oracle(
  sql: string,
  opts: OracleOptions = { params: 0 },
): Promise<string[]> {
  const problems: string[] = [];
  let tree: unknown;
  try {
    tree = await parse(sql);
  } catch (err) {
    return [`does not parse: ${err instanceof Error ? err.message : String(err)}`];
  }
  const stmts = (tree as { stmts?: Array<{ stmt?: unknown }> }).stmts ?? [];
  if (stmts.length !== 1) problems.push(`${stmts.length} statements`);
  const root = stmts[0]?.stmt;
  if (!(root && typeof root === "object" && "SelectStmt" in root)) {
    problems.push("root is not a SelectStmt");
  }

  const tables: Array<{ ref: string; qualified: boolean }> = [];
  const ctes = new Set<string>();
  let params = 0;

  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const v of value) walk(v);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
      if (key.endsWith("Stmt") && key !== "SelectStmt") problems.push(`contains ${key}`);
      if (key === "intoClause") problems.push("SELECT INTO");
      if (key === "LockingClause") problems.push("locking clause");
      if (key === "SQLValueFunction") problems.push("value keyword");
      if (key === "ParamRef") params += 1;
      if (key === "RangeVar") {
        const rv = field as {
          catalogname?: string;
          schemaname?: string;
          relname?: string;
        };
        if (rv.catalogname) problems.push(`catalog-qualified ${rv.relname}`);
        // The parser has already folded unquoted parts and kept quoted parts
        // as written; compare exactly, the way the server would look them up.
        const ref = rv.schemaname ? `${rv.schemaname}.${rv.relname}` : (rv.relname ?? "");
        tables.push({ ref, qualified: Boolean(rv.schemaname) });
      }
      if (key === "CommonTableExpr") {
        const cte = field as { ctename?: string };
        if (cte.ctename) ctes.add(cte.ctename);
      }
      if (key === "FuncCall") {
        const fn = field as { funcname?: Array<{ String?: { sval?: string } }> };
        const last = fn.funcname?.at(-1)?.String?.sval?.toLowerCase();
        if (last && ORACLE_FUNCTIONS.has(last)) problems.push(`calls ${last}`);
      }
      if (key === "A_Const") {
        const c = field as { sval?: { sval?: string } };
        const text = c.sval?.sval;
        if (typeof text === "string" && TIME_WORDS.has(text.trim().toLowerCase())) {
          problems.push(`time word '${text}'`);
        }
      }
      walk(field);
    }
  };
  walk(root);

  for (const t of tables) {
    if (allow.has(t.ref)) continue;
    if (!t.qualified && ctes.has(t.ref)) continue;
    problems.push(`reads ${t.ref}`);
  }
  if (params !== opts.params)
    problems.push(`${params} parameters, expected ${opts.params}`);

  try {
    const { tokens } = await scan(sql);
    if (
      tokens.some((t) => t.tokenName === "SQL_COMMENT" || t.tokenName === "C_COMMENT")
    ) {
      problems.push("contains a comment");
    }
  } catch {
    problems.push("does not tokenize");
  }
  return problems;
}

// --- Properties ------------------------------------------------------------------

test("corpus: every pinned input keeps its verdict", async () => {
  for (const entry of CORPUS) {
    const r = await validateSql(entry.sql, source);
    assert.equal(
      r.ok,
      entry.verdict === "accept",
      `${entry.note}\n  sql: ${JSON.stringify(entry.sql)}\n  got: ${r.ok ? "accepted" : r.error}`,
    );
    if (r.ok) {
      const plan = buildExecutablePlan({
        sql: entry.sql,
        timeField: "ts",
        from: new Date(0),
        to: new Date(1),
      });
      const problems = await oracle(plan.sql, { params: 2 });
      assert.deepEqual(
        problems,
        [],
        `${entry.note}\n  plan: ${JSON.stringify(plan.sql)}`,
      );
    }
  }
});

test("fuzz: a poisoned statement is always rejected", async () => {
  await run(
    fc.asyncProperty(poisoned, async ({ sql, poison }) => {
      const r = await validateSql(sql, source);
      assert.equal(
        r.ok,
        false,
        `accepted a statement containing ${poison}: ${JSON.stringify(sql)}`,
      );
    }),
  );
});

test("fuzz: a benign statement is always accepted", async () => {
  await run(
    fc.asyncProperty(benign, async ({ sql }) => {
      const r = await validateSql(sql, source);
      assert.equal(
        r.ok,
        true,
        `rejected a benign statement with "${r.error}": ${JSON.stringify(sql)}`,
      );
    }),
  );
});

test("fuzz: whatever the guard accepts satisfies the oracle", async () => {
  await run(
    fc.asyncProperty(rendered, async ({ sql }) => {
      const r = await validateSql(sql, source);
      if (!r.ok) return;
      const problems = await oracle(sql);
      assert.deepEqual(
        problems,
        [],
        `accepted ${JSON.stringify(sql)} but: ${problems.join("; ")}`,
      );
    }),
  );
});

/** One to three random edits to a benign statement: a deletion, an insertion of a SQL-significant character, or a duplicated slice. */
const mutated: fc.Arbitrary<string> = fc
  .tuple(
    benign,
    fc.array(
      fc.record({
        kind: fc.constantFrom("delete", "insert", "duplicate"),
        at: fc.nat(),
        len: fc.nat({ max: 12 }),
        ch: fc.constantFrom(
          ";",
          "'",
          '"',
          "$",
          "-",
          "/",
          "*",
          "(",
          ")",
          "\\",
          ",",
          ".",
          " ",
          "\n",
          "&",
          "U",
          "E",
          "0",
          "\u0000",
          "\u202e",
        ),
      }),
      { minLength: 1, maxLength: 3 },
    ),
  )
  .map(([{ sql }, edits]) => {
    let s = sql;
    for (const e of edits) {
      if (s.length === 0) break;
      const at = e.at % (s.length + 1);
      if (e.kind === "delete") s = s.slice(0, at) + s.slice(at + 1);
      else if (e.kind === "insert") s = s.slice(0, at) + e.ch + s.slice(at);
      else s = s.slice(0, at) + s.slice(at, at + e.len) + s.slice(at);
    }
    return s;
  });

test("fuzz: the guard never throws, and what it accepts of arbitrary input satisfies the oracle", async () => {
  const anyString = fc.oneof(
    { arbitrary: fc.string(), weight: 1 },
    { arbitrary: fc.string({ unit: "grapheme" }), weight: 1 },
    { arbitrary: mutated, weight: 4 },
  );
  await run(
    fc.asyncProperty(anyString, async (sql) => {
      let r: Awaited<ReturnType<typeof validateSql>>;
      try {
        r = await validateSql(sql, source);
      } catch (err) {
        assert.fail(
          `validateSql threw on ${JSON.stringify(sql)}: ${err instanceof Error ? err.stack : err}`,
        );
      }
      assert.equal(typeof r.ok, "boolean");
      if (!r.ok) return;
      const problems = await oracle(sql);
      assert.deepEqual(
        problems,
        [],
        `accepted ${JSON.stringify(sql)} but: ${problems.join("; ")}`,
      );
    }),
  );
});

const identifier = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,24}$/);

test("fuzz: the wrapped plan is one SELECT over the same relations with exactly the server's two parameters", async () => {
  await run(
    fc.asyncProperty(benign, identifier, async ({ sql }, timeField) => {
      const r = await validateSql(sql, source);
      fc.pre(r.ok);
      const from = new Date("2024-01-01T00:00:00Z");
      const to = new Date("2024-01-01T01:00:00Z");
      const plan = buildExecutablePlan({ sql, timeField, from, to });
      assert.deepEqual(plan.params, [from, to]);
      assert.equal(plan.timeField, timeField);
      const problems = await oracle(plan.sql, { params: 2 });
      assert.deepEqual(
        problems,
        [],
        `plan for ${JSON.stringify(sql)} with timeField ${JSON.stringify(timeField)}: ${problems.join("; ")}\n  plan: ${JSON.stringify(plan.sql)}`,
      );
    }),
  );
});

test("fuzz: a timeField that is not a bare identifier is refused before it reaches SQL", async () => {
  // An empty timeField means "no time filter", the same as omitting it.
  const none = buildExecutablePlan({
    sql: "SELECT ts FROM http_requests",
    timeField: "",
    from: new Date(0),
    to: new Date(1),
  });
  assert.deepEqual(none.params, []);

  const hostile = fc.oneof(
    fc.string({ minLength: 1 }).filter((s) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)),
    fc.constantFrom(
      "ts) OR 1=1 --",
      "ts; DROP TABLE x",
      'ts"',
      "ts.ts",
      "ts ",
      " ts",
      "1ts",
      "ts--",
      "ts/**/",
      "$1",
      "_holo.ts",
    ),
  );
  await run(
    fc.asyncProperty(hostile, async (timeField) => {
      assert.throws(
        () =>
          buildExecutablePlan({
            sql: "SELECT ts FROM http_requests",
            timeField,
            from: new Date(0),
            to: new Date(1),
          }),
        /invalid timeField/,
        `accepted timeField ${JSON.stringify(timeField)}`,
      );
    }),
  );
});
