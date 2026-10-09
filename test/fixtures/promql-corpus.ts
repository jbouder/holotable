/**
 * Seed corpus for the PromQL guard (#384): `test/promql-safety.test.ts` and
 * `test/promql-safety.fuzz.test.ts` both run every entry, so a shape somebody
 * found stays covered when the generators change. When the fuzzer reports a
 * counterexample, paste its exact `promql` here with the verdict it *should*
 * have, and add a named case to `test/promql-safety.test.ts` explaining why.
 *
 * The catalog these run against is `CORPUS_CATALOG` below; the declared
 * variables are `host` and `hosts`.
 */
export interface PromqlCorpusEntry {
  promql: string;
  verdict: "accept" | "reject";
  /** What this entry pins, for the failure message. */
  note: string;
}

export const CORPUS_CATALOG = {
  metrics: [
    { name: "http_requests_total", labels: ["job", "route", "status", "host"] },
    { name: "http_request_duration_seconds_bucket", labels: ["job", "route", "le"] },
    { name: "up", labels: ["job", "instance"] },
    { name: "node:cpu:rate5m", labels: ["instance"] },
  ],
};

export const CORPUS_VARIABLES = new Set(["host", "hosts"]);

export const PROMQL_CORPUS: PromqlCorpusEntry[] = [
  // --- Accepted -----------------------------------------------------------------
  { promql: "up", verdict: "accept", note: "a bare allowlisted metric" },
  {
    promql: 'sum by (route) (rate(http_requests_total{job="api"}[5m]))',
    verdict: "accept",
    note: "the umbrella's example shape",
  },
  {
    promql: 'sum by (route) (rate(http_requests_total{job="api", host=":host"}[5m]))',
    verdict: "accept",
    note: "a declared variable as a matcher's whole value",
  },
  {
    promql: 'up{instance=~":hosts"}',
    verdict: "accept",
    note: "a variable with a regex matcher",
  },
  {
    promql:
      "histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))",
    verdict: "accept",
    note: "a classic-histogram quantile",
  },
  {
    promql: '{__name__="up"}',
    verdict: "accept",
    note: "the metric as a __name__ equality",
  },
  { promql: '{"up"}', verdict: "accept", note: "the metric as a quoted name" },
  {
    promql: "node:cpu:rate5m",
    verdict: "accept",
    note: "a recording rule's name, colons and all",
  },
  {
    promql: "rate(up[5m] offset 1h)",
    verdict: "accept",
    note: "offset is relative to the server's window",
  },
  {
    promql: "up offset -1h",
    verdict: "accept",
    note: "a negative offset, within the bound",
  },
  { promql: "max_over_time(up[1h:5m])", verdict: "accept", note: "a bounded subquery" },
  { promql: "rate(up[7d])", verdict: "accept", note: "exactly the default range bound" },
  { promql: "up and on(job) up", verdict: "accept", note: "set operators with matching" },
  {
    promql: "topk(5, sum by (job) (up))",
    verdict: "accept",
    note: "an aggregation with a parameter",
  },
  { promql: 'count_values("v", up)', verdict: "accept", note: "a string parameter" },
  {
    promql: 'label_replace(up, "a", "$1", "instance", "(.*)")',
    verdict: "accept",
    note: "label functions take strings, none of them a variable",
  },
  {
    promql: "vector(1) + up",
    verdict: "accept",
    note: "a literal vector beside a selector",
  },
  { promql: "  up  ", verdict: "accept", note: "surrounding whitespace" },

  // --- Refused ------------------------------------------------------------------
  { promql: "", verdict: "reject", note: "empty" },
  { promql: "   ", verdict: "reject", note: "only whitespace" },
  {
    promql: "node_cpu_seconds_total",
    verdict: "reject",
    note: "a metric off the allowlist",
  },
  {
    promql: '{job="api"}',
    verdict: "reject",
    note: "a selector with no metric reads every series",
  },
  { promql: "{}", verdict: "reject", note: "an empty selector" },
  {
    promql: '{__name__=~".+"}',
    verdict: "reject",
    note: "__name__ as a pattern bypasses the allowlist",
  },
  {
    promql: '{__name__=~"up"}',
    verdict: "reject",
    note: "even a pattern that names one metric",
  },
  { promql: '{__name__!="up"}', verdict: "reject", note: "__name__ negated" },
  { promql: 'up{__name__="up"}', verdict: "reject", note: "the metric named twice" },
  {
    promql: '{"up", __name__="up"}',
    verdict: "reject",
    note: "the metric named twice, quoted",
  },
  {
    promql: '{"u\\x70"}',
    verdict: "reject",
    note: "a quoted metric name with an escape",
  },
  {
    promql: '{__name__="u\\x70"}',
    verdict: "reject",
    note: "a __name__ value with an escape",
  },
  { promql: "up @ start()", verdict: "reject", note: "@ start()" },
  { promql: "up @ end()", verdict: "reject", note: "@ end()" },
  { promql: "up @ 1609746000", verdict: "reject", note: "@ a timestamp" },
  { promql: "rate(up[5m] @ 1609746000)", verdict: "reject", note: "@ inside a function" },
  {
    promql: "max_over_time(up[1h:5m] @ end())",
    verdict: "reject",
    note: "@ on a subquery",
  },
  { promql: "rate(up[8d])", verdict: "reject", note: "a range over the bound" },
  {
    promql: "max_over_time(up[30d:1h])",
    verdict: "reject",
    note: "a subquery range over the bound",
  },
  { promql: "up offset 30d", verdict: "reject", note: "an offset over the bound" },
  {
    promql: "up offset -30d",
    verdict: "reject",
    note: "a negative offset over the bound",
  },
  {
    promql: "max_over_time(up[1h:1ms])",
    verdict: "reject",
    note: "a subquery step under a second",
  },
  { promql: "rate(up[5m * 2])", verdict: "reject", note: "duration arithmetic" },
  {
    promql: "info(up)",
    verdict: "reject",
    note: "info() reads target_info past the allowlist",
  },
  { promql: "limitk(1, up)", verdict: "reject", note: "an experimental aggregation" },
  {
    promql: "first_over_time(up[5m])",
    verdict: "reject",
    note: "an experimental function",
  },
  { promql: "up # comment", verdict: "reject", note: "a comment" },
  { promql: "up}}", verdict: "reject", note: "trailing garbage" },
  { promql: "up up", verdict: "reject", note: "two expressions" },
  { promql: 'up{job=":nope"}', verdict: "reject", note: "an undeclared variable" },
  {
    promql: 'up{job=~":hosts", job=":nope"}',
    verdict: "reject",
    note: "one declared, one not",
  },
  { promql: ":host", verdict: "reject", note: "a variable as a metric name" },
  {
    promql: '{__name__=":host"}',
    verdict: "reject",
    note: "a variable as a __name__ value",
  },
  {
    promql: 'label_replace(up, "a", ":host", "instance", "(.*)")',
    verdict: "reject",
    note: "a variable as a function argument",
  },
  { promql: '":host"', verdict: "reject", note: "a variable as the whole expression" },
  {
    promql: 'up{"job"="api"}',
    verdict: "reject",
    note: "a quoted label name in a matcher",
  },
  {
    promql: "rate(http_requests_total[5m]) / rate(node_cpu_seconds_total[5m])",
    verdict: "reject",
    note: "one side off the allowlist",
  },
];
