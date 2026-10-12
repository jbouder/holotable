import { LOGQL_MESSAGE_FIELD, PROMQL_TIME_FIELD } from "@/lib/ir";
import { rowsFromPrometheus } from "@/lib/prometheus/rows";
import type { QueryResult } from "@/lib/sources/execution";

/**
 * A Loki answer as the rows every panel renderer already draws (#562), so no
 * panel kind changes for a third query language:
 *
 * - **streams** (a log query) become one row per line: `time`, as an ISO
 *   instant from the line's nanosecond timestamp, `message`, then one column
 *   per stream label and per structured-metadata or parsed label, sorted.
 *   That is the `logs` kind's shape (#404): a time, a message, a `level`
 *   when the stream or a parser has one, and the rest behind each line. The
 *   rows run in the plan's `direction`, newest first for `backward`.
 * - **matrix**, **vector** and **scalar** (a metric query) are exactly what
 *   a Prometheus answer becomes (`prometheus/rows.ts`), which shares their
 *   wire shape: wide rows per step, one row per series, one value.
 *
 * A log query asks for at most `limit` lines. An answer with that many (or,
 * from a misbehaving endpoint, more, which are cut here) matched more than
 * were read, and says so as `truncated`, stage `entries`.
 */

const TIME = PROMQL_TIME_FIELD;
const MESSAGE = LOGQL_MESSAGE_FIELD;

type Labels = Record<string, string>;

interface Stream {
  stream?: Labels;
  values?: unknown[];
}

interface Line {
  ns: string;
  row: Record<string, unknown>;
}

/** A nanosecond timestamp as Loki sends it: a string of digits. */
function nanos(raw: unknown): string | null {
  return typeof raw === "string" && /^\d{1,30}$/.test(raw) ? raw : null;
}

/** Compare two digit strings as the numbers they are. */
function compareNanos(a: string, b: string): number {
  const x = a.replace(/^0+(?=\d)/, "");
  const y = b.replace(/^0+(?=\d)/, "");
  if (x.length !== y.length) return x.length - y.length;
  return x < y ? -1 : x > y ? 1 : 0;
}

function isoFromNanos(ns: string): string {
  const ms = ns.length > 6 ? Number(ns.slice(0, -6)) : 0;
  return new Date(ms).toISOString();
}

/** Label values only: a string-keyed object of strings, anything else dropped. */
function labels(raw: unknown): Labels {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Labels = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** A label that would shadow `time` or `message` keeps its value under another name. */
function column(label: string): string {
  return label === TIME || label === MESSAGE ? `${label}_label` : label;
}

function streams(
  result: unknown,
  opts: { limit: number; direction: "backward" | "forward" },
): QueryResult {
  const lines: Line[] = [];
  const names = new Set<string>();
  for (const s of Array.isArray(result) ? (result as Stream[]) : []) {
    const streamLabels = labels(s?.stream);
    for (const entry of Array.isArray(s?.values) ? s.values : []) {
      if (!Array.isArray(entry)) continue;
      const ns = nanos(entry[0]);
      if (ns === null || typeof entry[1] !== "string") continue;
      // With `categorize-labels`, a third element holds the line's own labels.
      const extra =
        typeof entry[2] === "object" && entry[2] !== null
          ? (entry[2] as { structuredMetadata?: unknown; parsed?: unknown })
          : {};
      const all = {
        ...streamLabels,
        ...labels(extra.structuredMetadata),
        ...labels(extra.parsed),
      };
      const row: Record<string, unknown> = {
        [TIME]: isoFromNanos(ns),
        [MESSAGE]: entry[1],
      };
      for (const [k, v] of Object.entries(all)) {
        const name = column(k);
        row[name] = v;
        names.add(name);
      }
      lines.push({ ns, row });
    }
  }
  const sign = opts.direction === "backward" ? -1 : 1;
  // Array.prototype.sort is stable: lines at one instant keep Loki's order.
  lines.sort((a, b) => sign * compareNanos(a.ns, b.ns));
  const labelColumns = [...names].sort();
  const kept = lines.slice(0, opts.limit);
  const rows = kept.map(({ row }) => {
    // A line without a label is null there, never missing.
    for (const c of labelColumns) if (!(c in row)) row[c] = null;
    return row;
  });
  const out: QueryResult = { columns: [TIME, MESSAGE, ...labelColumns], rows };
  if (lines.length >= opts.limit) {
    out.truncated = { stage: "entries", kept: rows.length };
  }
  return out;
}

/**
 * Rows from a Loki answer's `data`. `limit` and `direction` are the plan's,
 * for a log query; `maxSeries` bounds a metric query's series.
 */
export function rowsFromLoki(
  data: unknown,
  opts: { maxSeries: number; limit: number; direction: "backward" | "forward" },
): QueryResult {
  const { resultType, result } = (data ?? {}) as {
    resultType?: unknown;
    result?: unknown;
  };
  if (resultType === "streams") return streams(result, opts);
  if (resultType === "matrix" || resultType === "vector" || resultType === "scalar") {
    return rowsFromPrometheus(data, opts.maxSeries);
  }
  throw new Error(`Loki answered with an unknown result type ${String(resultType)}`);
}
