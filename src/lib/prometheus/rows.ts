import { PROMQL_TIME_FIELD } from "@/lib/ir";
import { QueryExecutionError, type QueryResult } from "@/lib/sources/execution";

/**
 * A Prometheus answer as the rows every panel renderer already draws (#385),
 * so no panel kind changes for a second query language:
 *
 * - a **matrix** (a range query) becomes wide rows: `time`, as an ISO instant,
 *   then one numeric column per series, named the way the Prometheus UI names
 *   a legend entry — `metric{label="v", …}`, with the metric name left off
 *   when every series shares it, and `{}` for a series with no labels;
 * - a **vector** (an instant query) becomes one row per series: a column per
 *   label, sorted, then `value`;
 * - a **scalar** is one row, `value`; a **string** is one row, `value`.
 *
 * `NaN` and `±Inf` become null, as a SQL NULL does. More series than
 * `maxSeries` is the author's to narrow, and a native-histogram sample is
 * refused until a renderer can draw one.
 */

type Labels = Record<string, string>;
type Sample = [number, string];

interface Series {
  metric?: Labels;
  values?: Sample[];
  value?: Sample;
  histograms?: unknown;
  histogram?: unknown;
}

interface Data {
  resultType?: string;
  result?: unknown;
}

const NAME = "__name__";

function number(raw: string): number | null {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/** The legend name of one series. */
export function seriesName(metric: Labels, keepName: boolean): string {
  const labels = Object.keys(metric)
    .filter((k) => k !== NAME)
    .sort()
    .map((k) => `${k}=${quote(metric[k])}`)
    .join(", ");
  const name = keepName ? (metric[NAME] ?? "") : "";
  return `${name}{${labels}}`;
}

function refuseHistograms(series: Series[]): void {
  if (series.some((s) => s.histograms !== undefined || s.histogram !== undefined)) {
    throw new QueryExecutionError(
      "this query returns native histogram samples, which a panel cannot draw yet; use histogram_quantile() over classic _bucket series",
    );
  }
}

function capSeries(series: Series[], maxSeries: number): void {
  if (series.length > maxSeries) {
    throw new QueryExecutionError(
      `this query returns ${series.length} series, more than the ${maxSeries} a panel may draw; narrow it with sum by (…) or a label matcher`,
    );
  }
}

/** Whether every series carries the same metric name, or none does. */
function sharedName(series: Series[]): boolean {
  const names = new Set(series.map((s) => s.metric?.[NAME]));
  return names.size <= 1;
}

export function rowsFromPrometheus(data: unknown, maxSeries: number): QueryResult {
  const { resultType, result } = (data ?? {}) as Data;
  if (resultType === "matrix") return matrix(asSeries(result), maxSeries);
  if (resultType === "vector") return vector(asSeries(result), maxSeries);
  if (resultType === "scalar" || resultType === "string") {
    const sample = result as Sample | undefined;
    const raw = sample?.[1] ?? "";
    return {
      columns: ["value"],
      rows: [{ value: resultType === "scalar" ? number(raw) : raw }],
    };
  }
  throw new Error(
    `Prometheus answered with an unknown result type ${String(resultType)}`,
  );
}

function asSeries(result: unknown): Series[] {
  return Array.isArray(result) ? (result as Series[]) : [];
}

function matrix(series: Series[], maxSeries: number): QueryResult {
  refuseHistograms(series);
  capSeries(series, maxSeries);
  const keepName = !sharedName(series);
  const columns = series.map((s) => seriesName(s.metric ?? {}, keepName));
  const byTime = new Map<number, Record<string, unknown>>();
  series.forEach((s, i) => {
    for (const [t, raw] of s.values ?? []) {
      let row = byTime.get(t);
      if (!row) {
        row = { [PROMQL_TIME_FIELD]: new Date(t * 1000).toISOString() };
        byTime.set(t, row);
      }
      row[columns[i]] = number(raw);
    }
  });
  const rows = [...byTime.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, row]) => {
      // A series with no sample at this time is null, never missing.
      for (const c of columns) if (!(c in row)) row[c] = null;
      return row;
    });
  return { columns: [PROMQL_TIME_FIELD, ...columns], rows };
}

function vector(series: Series[], maxSeries: number): QueryResult {
  refuseHistograms(series);
  capSeries(series, maxSeries);
  const keepName = !sharedName(series);
  const labels = [...new Set(series.flatMap((s) => Object.keys(s.metric ?? {})))]
    .filter((k) => keepName || k !== NAME)
    .sort();
  const rows = series.map((s) => {
    const row: Record<string, unknown> = {};
    for (const l of labels) row[l] = s.metric?.[l] ?? null;
    row.value = s.value ? number(s.value[1]) : null;
    return row;
  });
  return { columns: [...labels, "value"], rows };
}
