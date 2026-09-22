/**
 * The Prometheus text exposition format, parsed into rows.
 *
 * This is the demo collector's half of the self-monitoring loop (#54): the app
 * exposes its own instruments at `/api/metrics`, `scripts/self-metrics.ts`
 * scrapes them, and this module turns the scrape into rows for the
 * `metrics.holotable_self` hypertable that Holotable then queries like any
 * other source.
 *
 * Why parse the text format rather than remote-write into Postgres: remote
 * write needs a translating sidecar, and the point of the demo is that the
 * whole loop is small enough to read. The text format is stable, documented,
 * and the thing a scrape actually returns.
 *
 * It is a *demo* collector, not a general ingester. {@link COLLECTED_FAMILIES}
 * is a deliberate allowlist, so a scrape lands ~40 rows rather than every
 * default Node instrument four times a minute for a week.
 */

/** One `name{labels} value` line. */
export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/**
 * The labels this schema promotes to columns of their own: every label the
 * app's own instruments use (`src/lib/metrics.ts`). Anything else a scrape
 * carries survives in the `labels` column rather than being dropped, so two
 * series never collapse into one row.
 */
export const PROMOTED_LABELS = [
  "dashboard",
  "source",
  "workspace",
  "model",
  "direction",
  "route",
  "reason",
  "outcome",
] as const;
export type PromotedLabel = (typeof PROMOTED_LABELS)[number];

/**
 * The metric families the collector stores, without the `_bucket` / `_sum` /
 * `_count` suffix a histogram adds.
 *
 * Kept next to the panels that read them: `test/self-monitoring.test.ts`
 * asserts every family the committed dashboard queries appears here, so a
 * panel can never be written against a metric nothing collects.
 */
export const COLLECTED_FAMILIES: ReadonlySet<string> = new Set([
  "holotable_poller_tick_duration_seconds",
  "holotable_query_duration_seconds",
  "holotable_query_rows",
  "holotable_sse_subscribers",
  "holotable_pollers_active",
  "holotable_llm_tokens_total",
  "holotable_llm_requests_total",
  "holotable_sql_validation_rejections_total",
  "holotable_process_resident_memory_bytes",
  "holotable_nodejs_heap_size_used_bytes",
  "holotable_nodejs_eventloop_lag_p99_seconds",
]);

/** One row of `metrics.holotable_self`. Column order matches {@link ROW_COLUMNS}. */
export interface MetricRow {
  metric: string;
  labels: string;
  dashboard: string | null;
  source: string | null;
  workspace: string | null;
  model: string | null;
  direction: string | null;
  route: string | null;
  reason: string | null;
  outcome: string | null;
  /** Histogram bucket bound. `null` for `+Inf` and for everything that is not a bucket. */
  le: number | null;
  value: number;
}

/** The insert column list, in the order {@link rowValues} emits. */
export const ROW_COLUMNS = [
  "metric",
  "labels",
  "dashboard",
  "source",
  "workspace",
  "model",
  "direction",
  "route",
  "reason",
  "outcome",
  "le",
  "value",
] as const;

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*/;
const HISTOGRAM_SUFFIXES = ["_bucket", "_sum", "_count"];

/**
 * Parse a scrape body. Malformed lines are skipped rather than thrown on: a
 * collector that dies on one unexpected line stops reporting everything else,
 * and this one has no business being stricter than the scraper it imitates.
 */
export function parseExposition(text: string): Sample[] {
  const samples: Sample[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const sample = parseLine(line);
    if (sample) samples.push(sample);
  }
  return samples;
}

function parseLine(line: string): Sample | null {
  const name = NAME.exec(line)?.[0];
  if (!name) return null;

  let rest = line.slice(name.length);
  let labels: Record<string, string> = {};
  if (rest.startsWith("{")) {
    const parsed = parseLabels(rest);
    if (!parsed) return null;
    labels = parsed.labels;
    rest = parsed.rest;
  }

  // What is left is `<value>` or `<value> <timestamp>`. The timestamp is the
  // exposition's own, which the app does not set; the collector stamps rows
  // with the scrape time instead, so it is read and discarded.
  const value = parseValue(rest.trim().split(/[ \t]+/)[0] ?? "");
  return value === null ? null : { name, labels, value };
}

/**
 * Read a `{k="v",k2="v2"}` clause. Label values are quoted and may contain
 * `\\`, `\"` and `\n` escapes, so this reads them character by character
 * rather than splitting on commas — a comma inside a value is legal.
 */
function parseLabels(
  input: string,
): { labels: Record<string, string>; rest: string } | null {
  const labels: Record<string, string> = {};
  let i = 1; // past '{'
  for (;;) {
    while (i < input.length && /[\s,]/.test(input[i])) i++;
    if (i >= input.length) return null;
    if (input[i] === "}") return { labels, rest: input.slice(i + 1) };

    const key = NAME.exec(input.slice(i))?.[0];
    if (!key) return null;
    i += key.length;
    while (i < input.length && /\s/.test(input[i])) i++;
    if (input[i] !== "=") return null;
    i++;
    while (i < input.length && /\s/.test(input[i])) i++;
    if (input[i] !== '"') return null;
    i++;

    let value = "";
    for (;;) {
      if (i >= input.length) return null;
      const ch = input[i];
      if (ch === '"') {
        i++;
        break;
      }
      if (ch === "\\") {
        const next = input[i + 1];
        value += next === "n" ? "\n" : next === undefined ? "" : next;
        i += 2;
        continue;
      }
      value += ch;
      i++;
    }
    labels[key] = value;
  }
}

/** `1.5`, `+Inf`, `-Inf` and `NaN` are all legal sample values. */
function parseValue(token: string): number | null {
  if (token.length === 0) return null;
  if (token === "+Inf") return Number.POSITIVE_INFINITY;
  if (token === "-Inf") return Number.NEGATIVE_INFINITY;
  if (token === "NaN") return Number.NaN;
  const value = Number(token);
  return Number.isNaN(value) ? null : value;
}

/** The family a sample belongs to: its name with any histogram suffix removed. */
export function metricFamily(name: string): string {
  const suffix = HISTOGRAM_SUFFIXES.find((s) => name.endsWith(s));
  return suffix ? name.slice(0, -suffix.length) : name;
}

/** Is this sample one the demo collector stores? */
export function isCollected(sample: Sample): boolean {
  return COLLECTED_FAMILIES.has(metricFamily(sample.name));
}

/**
 * The full label set, canonically serialized, so two series of the same metric
 * stay distinguishable even when their distinguishing label is not promoted to
 * a column. Sorted, because a scrape's label order is not guaranteed and this
 * value is compared and grouped on.
 */
export function canonicalLabels(labels: Record<string, string>): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${JSON.stringify(labels[k])}`)
    .join(",");
}

/** Turn one sample into the row the hypertable stores. */
export function toRow(sample: Sample): MetricRow {
  const promoted = Object.fromEntries(
    PROMOTED_LABELS.map((label) => [label, sample.labels[label] ?? null]),
  ) as Record<PromotedLabel, string | null>;

  return {
    metric: sample.name,
    labels: canonicalLabels(sample.labels),
    ...promoted,
    // `+Inf` is stored as NULL rather than as an infinity, so a panel can ask
    // for the real buckets with `le IS NOT NULL` and never has to write the
    // literal `'infinity'` — which the SQL guard refuses, because to
    // PostgreSQL that string is also a timestamp.
    le: bucketBound(sample),
    value: sample.value,
  };
}

function bucketBound(sample: Sample): number | null {
  if (!sample.name.endsWith("_bucket")) return null;
  const le = sample.labels.le;
  if (le === undefined || le === "+Inf") return null;
  const bound = Number(le);
  return Number.isFinite(bound) ? bound : null;
}

/** One row as positional values, in {@link ROW_COLUMNS} order. */
export function rowValues(row: MetricRow): unknown[] {
  return ROW_COLUMNS.map((column) => row[column]);
}
