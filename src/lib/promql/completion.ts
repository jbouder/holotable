/**
 * What the PromQL editor completes (#388), as pure functions over the
 * catalog the editor is sent (the kind's listing of metrics and labels, never
 * the URL): metric names and functions where an expression can start, and a
 * metric's labels inside its braces. Browser-safe: no parser, no guard.
 */

export interface PromqlCompletionCatalog {
  metrics: { name: string; type: string; help?: string; labels: string[] }[];
}

export interface PromqlCompletion {
  label: string;
  type: "variable" | "function" | "property";
  detail?: string;
  info?: string;
}

export type PromqlCompletionContext =
  | { kind: "expression"; from: number }
  | { kind: "label"; from: number; metric: string | null }
  | { kind: "none" };

/** The functions and aggregations the guard allows, for completion. */
export const PROMQL_FUNCTIONS = [
  "abs",
  "absent",
  "absent_over_time",
  "avg",
  "avg_over_time",
  "bottomk",
  "ceil",
  "changes",
  "clamp",
  "clamp_max",
  "clamp_min",
  "count",
  "count_over_time",
  "count_values",
  "delta",
  "deriv",
  "exp",
  "floor",
  "group",
  "histogram_quantile",
  "idelta",
  "increase",
  "irate",
  "label_join",
  "label_replace",
  "last_over_time",
  "ln",
  "log10",
  "log2",
  "max",
  "max_over_time",
  "min",
  "min_over_time",
  "predict_linear",
  "quantile",
  "quantile_over_time",
  "rate",
  "resets",
  "round",
  "scalar",
  "sort",
  "sort_desc",
  "sqrt",
  "stddev",
  "stddev_over_time",
  "stdvar",
  "sum",
  "sum_over_time",
  "time",
  "timestamp",
  "topk",
  "vector",
];

const WORD = /[A-Za-z0-9_:]/;

/**
 * Where the cursor is: starting an expression (a metric or a function), or
 * naming a label inside a selector's braces. Inside a quoted value nothing
 * is offered; a value is the author's.
 */
export function promqlCompletionContext(
  text: string,
  pos: number,
): PromqlCompletionContext {
  let from = pos;
  while (from > 0 && WORD.test(text[from - 1])) from--;

  // Walk the text before the word, tracking braces and quotes.
  let depth = 0;
  let open = -1;
  let quote: string | null = null;
  for (let i = 0; i < from; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") {
      depth++;
      open = i;
    } else if (c === "}") depth = Math.max(0, depth - 1);
  }
  if (quote) return { kind: "none" };
  if (depth === 0) return { kind: "expression", from };

  // Inside braces: a label name comes after `{` or `,`, never after an operator.
  const before = text.slice(open + 1, from).trimEnd();
  if (before !== "" && !before.endsWith(",")) return { kind: "none" };
  let end = open;
  while (end > 0 && text[end - 1] === " ") end--;
  let start = end;
  while (start > 0 && WORD.test(text[start - 1])) start--;
  const metric = start < end ? text.slice(start, end) : null;
  return { kind: "label", from, metric };
}

/** The completions at `pos`, and where the word they replace starts. */
export function promqlCompletions(
  catalog: PromqlCompletionCatalog,
  text: string,
  pos: number,
): { from: number; options: PromqlCompletion[] } | null {
  const context = promqlCompletionContext(text, pos);
  if (context.kind === "none") return null;
  if (context.kind === "label") {
    const metric = context.metric
      ? catalog.metrics.find((m) => m.name === context.metric)
      : undefined;
    const labels = metric
      ? metric.labels
      : [...new Set(catalog.metrics.flatMap((m) => m.labels))].sort();
    return {
      from: context.from,
      options: labels.map((label) => ({
        label,
        type: "property",
        detail: metric ? `label of ${metric.name}` : "label",
      })),
    };
  }
  return {
    from: context.from,
    options: [
      ...catalog.metrics.map((m) => ({
        label: m.name,
        type: "variable" as const,
        detail: m.type,
        ...(m.help ? { info: m.help } : {}),
      })),
      ...PROMQL_FUNCTIONS.map((f) => ({ label: f, type: "function" as const })),
    ],
  };
}

export interface PromqlDiagnostic {
  from: number;
  to: number;
  severity: "error" | "warning";
  message: string;
}

/** The first name a hint mentions that the text holds, as a range in it. */
function rangeOf(text: string, message: string): { from: number; to: number } | null {
  for (const word of message.match(/[A-Za-z_:][A-Za-z0-9_:]*/g) ?? []) {
    // A function name is what the hint is about, never where: the metric is.
    if (PROMQL_FUNCTIONS.includes(word)) continue;
    // Names are word characters and colons only, so nothing needs escaping.
    const at = new RegExp(`(?<![A-Za-z0-9_:])${word}(?![A-Za-z0-9_:])`).exec(text);
    if (at) return { from: at.index, to: at.index + word.length };
  }
  return null;
}

/**
 * The guard's verdict as editor diagnostics (#388). The guard answers in
 * sentences, not ranges: a refusal that names a character is placed there,
 * a hint is placed on the first metric or label it names, and anything else
 * underlines the whole expression.
 */
export function promqlDiagnostics(
  text: string,
  verdict: { ok: true; hints?: string[] } | { ok: false; error: string },
): PromqlDiagnostic[] {
  const whole = { from: 0, to: Math.max(text.length, 0) };
  if (!verdict.ok) {
    const at = /at character (\d+)/.exec(verdict.error);
    const pos = at ? Math.min(Math.max(Number(at[1]) - 1, 0), text.length) : null;
    const range =
      pos === null
        ? (rangeOf(text, verdict.error) ?? whole)
        : { from: pos, to: Math.min(pos + 1, text.length) };
    return [{ ...range, severity: "error", message: verdict.error }];
  }
  return (verdict.hints ?? []).map((message) => ({
    ...(rangeOf(text, message) ?? whole),
    severity: "warning",
    message,
  }));
}
