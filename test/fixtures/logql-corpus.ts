/**
 * Seed corpus for the LogQL guard (#561): `test/logql-safety.test.ts` and
 * `test/logql-safety.fuzz.test.ts` both run every entry, so a shape somebody
 * found stays covered when the generators change. When the fuzzer reports a
 * counterexample, paste its exact `logql` here with the verdict it *should*
 * have, and add a named case to `test/logql-safety.test.ts` explaining why.
 *
 * The catalog these run against is `CORPUS_CATALOG` below; the declared
 * variables are `env`, `needle` and `envs`.
 */
export interface LogqlCorpusEntry {
  logql: string;
  verdict: "accept" | "reject";
  /** What this entry pins, for the failure message. */
  note: string;
}

export const CORPUS_CATALOG = {
  labels: [
    { name: "app", values: ["api", "web"] },
    { name: "env", values: ["prod", "staging"] },
    { name: "namespace" },
    { name: "tenant" },
  ],
};

export const CORPUS_VARIABLES = new Set(["env", "needle", "envs"]);

export const LOGQL_CORPUS: LogqlCorpusEntry[] = [
  // --- Accepted -----------------------------------------------------------------
  { logql: '{app="api"}', verdict: "accept", note: "one anchored selector" },
  {
    logql: '{app="api", env=":env"} |= "error" | json | level="error"',
    verdict: "accept",
    note: "the umbrella's log example",
  },
  {
    logql: 'sum by (route) (rate({app="api"} | json | status >= 500 [5m]))',
    verdict: "accept",
    note: "the umbrella's metric example",
  },
  {
    logql: '{env=":env"}',
    verdict: "accept",
    note: "a variable is the anchor; the plan checks it again once bound",
  },
  {
    logql: '{app="api"} |= ":needle"',
    verdict: "accept",
    note: "a variable line filter",
  },
  { logql: '{app="api"} != ":needle"', verdict: "accept", note: "a negated one" },
  {
    logql: '{app="api"} | json | level!=":env"',
    verdict: "accept",
    note: "a variable in a label filter matcher",
  },
  {
    logql: '{app="api", namespace=~"prod-.*"}',
    verdict: "accept",
    note: "a regex beside the anchor",
  },
  {
    logql: '{app="api", pod="x"}',
    verdict: "accept",
    note: "an unlisted label beside the anchor is a hint",
  },
  { logql: "{app=`api`}", verdict: "accept", note: "a raw string value" },
  {
    logql: '{app="api"} |= "a" != "b" |~ "c|d" !~ "e" |> "<_> f" !> "g"',
    verdict: "accept",
    note: "every line filter",
  },
  {
    logql: '{app="api"} |= ip("10.0.0.0/8") or "x"',
    verdict: "accept",
    note: "ip() and an or alternative",
  },
  {
    logql:
      '{app="api"} | logfmt --strict --keep-empty a="b", c | pattern "<_> <x>" | regexp "(?P<y>.)" | unpack',
    verdict: "accept",
    note: "every parser",
  },
  {
    logql:
      '{app="api"} | json a="b.c" | addr = ip("1.2.3.4") | d > 5s and s <= 1KB or (n == 3, m != 4)',
    verdict: "accept",
    note: "label filters of every kind",
  },
  {
    logql:
      '{app="api"} | line_format "{{.msg}}" | label_format a=b, c="{{.d}}" | keep a, b="c" | drop d, e=~"f" | decolorize',
    verdict: "accept",
    note: "formatting and label stages",
  },
  {
    logql:
      'quantile_over_time(0.99, {app="api"} | unwrap duration_seconds(lat) | lat > 1 [5m]) by (route)',
    verdict: "accept",
    note: "unwrap with a conversion and a post-filter",
  },
  {
    logql: 'rate({app="api"}[5m] offset 1h)',
    verdict: "accept",
    note: "an offset within the bound",
  },
  {
    logql: 'count_over_time({app="api"}[7d])',
    verdict: "accept",
    note: "exactly the bound",
  },
  {
    logql: 'rate({app="api"}[1.5h])',
    verdict: "accept",
    note: "a fractional duration",
  },
  {
    logql: 'sum(rate({app="api"}[5m])) / on(x) group_left(y) sum(rate({env="prod"}[5m]))',
    verdict: "accept",
    note: "a binary operator with matching",
  },
  {
    logql: 'topk(5, sum by (app) (bytes_rate({app="api"}[5m])))',
    verdict: "accept",
    note: "an aggregation with a parameter",
  },
  {
    logql: 'label_replace(rate({app="api"}[5m]), "a", "$1", "b", "(.*)")',
    verdict: "accept",
    note: "label_replace takes strings, none of them a variable",
  },
  {
    logql: 'rate_counter({app="api"} | unwrap n [5m]) > bool 2',
    verdict: "accept",
    note: "a Loki range function and a bool comparison",
  },
  { logql: "vector(1)", verdict: "accept", note: "no selector at all reads nothing" },
  { logql: '({app="api"})', verdict: "accept", note: "a parenthesized log query" },
  {
    logql: 'rate(({app="api"} |= "x")[5m])',
    verdict: "accept",
    note: "a parenthesized range",
  },
  { logql: '  {app="api"}  ', verdict: "accept", note: "surrounding whitespace" },

  // --- Refused ------------------------------------------------------------------
  { logql: "", verdict: "reject", note: "empty" },
  { logql: "   ", verdict: "reject", note: "only whitespace" },
  { logql: "{}", verdict: "reject", note: "an empty selector does not parse" },
  { logql: '{app=~".*"}', verdict: "reject", note: "a regex-only selector" },
  { logql: '{app=~"api"}', verdict: "reject", note: "even a regex naming one value" },
  { logql: '{app!="api"}', verdict: "reject", note: "only a negation" },
  { logql: '{app=""}', verdict: "reject", note: "an empty value matches the unlabeled" },
  { logql: '{pod="x"}', verdict: "reject", note: "anchored only on an unlisted label" },
  {
    logql: 'rate({app="api"}[5m]) / rate({pod="x"}[5m])',
    verdict: "reject",
    note: "one side unanchored",
  },
  { logql: '{app="api"} # note', verdict: "reject", note: "a comment" },
  { logql: '{app="api"} {app="web"}', verdict: "reject", note: "two expressions" },
  { logql: '{app="api"}}', verdict: "reject", note: "trailing garbage" },
  { logql: '{app="api"} @ 1609746000', verdict: "reject", note: "@ does not parse" },
  {
    logql: 'rate({app="api"}[5m] @ 1609746000)',
    verdict: "reject",
    note: "@ inside a range",
  },
  { logql: 'rate({app="api"}[8d])', verdict: "reject", note: "a range over the bound" },
  { logql: 'rate({app="api"}[-5m])', verdict: "reject", note: "a negative range" },
  {
    logql: 'rate({app="api"}[5m] offset 8d)',
    verdict: "reject",
    note: "an offset over the bound",
  },
  {
    logql: 'rate({app="api"}[5m] offset -1h)',
    verdict: "reject",
    note: "a negative offset reads the future",
  },
  {
    logql: '{app="api"} + 1',
    verdict: "reject",
    note: "a log query as an operator's operand",
  },
  { logql: '{app="api"} |~ ":needle"', verdict: "reject", note: "a variable in a regex" },
  {
    logql: '{app="api"} !~ ":needle"',
    verdict: "reject",
    note: "a variable in a negated regex",
  },
  {
    logql: '{app="api"} |> ":needle"',
    verdict: "reject",
    note: "a variable in a pattern filter",
  },
  { logql: '{app=~":env"}', verdict: "reject", note: "a variable in a regex matcher" },
  {
    logql: '{app="api"} | regexp ":env"',
    verdict: "reject",
    note: "a variable as a regexp parser",
  },
  {
    logql: '{app="api"} | pattern ":env"',
    verdict: "reject",
    note: "a variable as a pattern parser",
  },
  {
    logql: '{app="api"} |~ "x" or ":needle"',
    verdict: "reject",
    note: "a variable in a regex's or alternative",
  },
  {
    logql: '{app="api"} |= "x" or ":needle"',
    verdict: "reject",
    note: "an or alternative is not a variable slot",
  },
  {
    logql: '{app="api"} |= ip(":needle")',
    verdict: "reject",
    note: "a variable as an ip() argument",
  },
  {
    logql: '{app="api"} | line_format ":env"',
    verdict: "reject",
    note: "a variable as a template",
  },
  {
    logql: 'label_replace(rate({app="api"}[5m]), "a", ":env", "b", "(.*)")',
    verdict: "reject",
    note: "a variable as a function argument",
  },
  {
    logql: '{app="api", env=":nope"}',
    verdict: "reject",
    note: "an undeclared variable",
  },
  {
    logql: '{app="api", :env="x"}',
    verdict: "reject",
    note: "a variable as a label name",
  },
  {
    logql: 'sum by (:env) (rate({app="api"}[5m]))',
    verdict: "reject",
    note: "a variable as a grouping label",
  },
  {
    logql: '{app="api"} |= "unterminated',
    verdict: "reject",
    note: "an unclosed string",
  },
  {
    logql: '{app="api"} | unwrap x',
    verdict: "reject",
    note: "unwrap outside a range function does not parse",
  },

  // --- Found by the fuzzer --------------------------------------------------------
  {
    // Fuzz counterexample #1 (seed 1): the generator joined `| keep a, b` and
    // `!= ":needle"`, meaning a line filter; the grammar reads one keep
    // matcher, `b != ":needle"`, where a variable may not go. The guard was
    // right and the generator wrong.
    logql: '{app="api"} | keep a, b != ":needle"',
    verdict: "reject",
    note: "a != after a keep list is a keep matcher, not a line filter",
  },
];
