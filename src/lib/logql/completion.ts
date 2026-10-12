/**
 * What the LogQL editor completes (#565), as pure functions over the catalog
 * the editor is sent (the kind's label allowlist with its value hints, never
 * the URL): label names inside a stream selector's braces and in a
 * `by (…)`, a listed label's values inside a matcher's quotes, the pipeline
 * stages after a `|`, and the functions and aggregations where an expression
 * can start. Browser-safe: no parser, no guard.
 */

export interface LogqlCompletionCatalog {
  labels: { name: string; values: string[] }[];
}

export interface LogqlCompletion {
  label: string;
  type: "function" | "keyword" | "property" | "constant";
  detail?: string;
  /** The text inserted, when it is not the label: a value escaped for its string. */
  apply?: string;
}

export type LogqlCompletionContext =
  | { kind: "expression"; from: number }
  | { kind: "label"; from: number }
  | { kind: "stage"; from: number }
  | { kind: "value"; from: number; label: string; regex: boolean }
  | { kind: "none" };

/** The range functions the guard allows, as they are written. */
export const LOGQL_RANGE_FUNCTIONS = [
  "absent_over_time",
  "avg_over_time",
  "bytes_over_time",
  "bytes_rate",
  "count_over_time",
  "first_over_time",
  "last_over_time",
  "max_over_time",
  "min_over_time",
  "quantile_over_time",
  "rate",
  "rate_counter",
  "stddev_over_time",
  "stdvar_over_time",
  "sum_over_time",
];

/** The aggregations the guard allows, and the two plain functions. */
export const LOGQL_AGGREGATIONS = [
  "avg",
  "bottomk",
  "count",
  "label_replace",
  "max",
  "min",
  "sort",
  "sort_desc",
  "stddev",
  "stdvar",
  "sum",
  "topk",
  "vector",
];

/** The pipeline stages the guard allows after a `|`, other than a label filter. */
export const LOGQL_STAGES = [
  "decolorize",
  "drop",
  "json",
  "keep",
  "label_format",
  "line_format",
  "logfmt",
  "pattern",
  "regexp",
  "unpack",
  "unwrap",
];

const WORD = /[A-Za-z0-9_]/;

/** The word that ends just before `end`, skipping spaces. */
function wordBefore(text: string, end: number): string {
  let stop = end;
  while (stop > 0 && text[stop - 1] === " ") stop--;
  let start = stop;
  while (start > 0 && WORD.test(text[start - 1])) start--;
  return text.slice(start, stop);
}

/** A matcher's label and operator, written just before a quote at `quote`. */
const MATCHER_BEFORE = /([A-Za-z_][A-Za-z0-9_]*)\s*(=~|!~|!=|=)\s*$/;

/**
 * Where the cursor is. Inside a quoted string the only thing offered is a
 * listed label's values, and only when the string is that label's matcher
 * value; any other string (a line filter, a format template) is the author's.
 */
export function logqlCompletionContext(
  text: string,
  pos: number,
): LogqlCompletionContext {
  let from = pos;
  while (from > 0 && WORD.test(text[from - 1])) from--;

  // Walk the text before the cursor, tracking braces, parentheses and quotes.
  let depth = 0;
  let open = -1;
  const parens: number[] = [];
  let quote: string | null = null;
  let quoteAt = -1;
  for (let i = 0; i < pos; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote !== "`") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (i >= from) break;
    if (c === '"' || c === "`") {
      quote = c;
      quoteAt = i;
    } else if (c === "#") {
      // A comment runs to the end of the line; the guard refuses it anyway.
      const end = text.indexOf("\n", i);
      if (end < 0 || end >= from) return { kind: "none" };
      i = end;
    } else if (c === "{") {
      depth++;
      open = i;
    } else if (c === "}") depth = Math.max(0, depth - 1);
    else if (c === "(") parens.push(i);
    else if (c === ")") parens.pop();
  }

  if (quote) {
    const matcher = MATCHER_BEFORE.exec(text.slice(0, quoteAt));
    if (!matcher || quote === "`") return { kind: "none" };
    return {
      kind: "value",
      from: quoteAt + 1,
      label: matcher[1],
      regex: matcher[2] === "=~" || matcher[2] === "!~",
    };
  }

  if (depth > 0) {
    // A label name comes after `{` or `,`, never after an operator.
    const before = text.slice(open + 1, from).trimEnd();
    return before === "" || before.endsWith(",")
      ? { kind: "label", from }
      : { kind: "none" };
  }

  let prev = from;
  while (prev > 0 && text[prev - 1] === " ") prev--;
  const last = text[prev - 1];
  // `| json`, `| level="error"`: a stage, or a label to filter on.
  if (last === "|") return { kind: "stage", from };
  // `by (job, …)`, `without (…)`, `sum(…) by (…)`.
  const paren = parens.at(-1);
  if (paren !== undefined && (last === "(" || last === ",")) {
    const word = wordBefore(text, paren);
    if (word === "by" || word === "without") return { kind: "label", from };
  }
  if (last === undefined || last === "(" || last === "," || /[-+*/%^=<>!]/.test(last)) {
    return { kind: "expression", from };
  }
  // After a word or a closing bracket: an operator or `by` comes next, not a name.
  return { kind: "none" };
}

/** A value as it is written inside a double-quoted LogQL string. */
function quoted(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/** A value as a regex that matches only itself, for `=~` and `!~`. */
function literalRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function labelOptions(catalog: LogqlCompletionCatalog): LogqlCompletion[] {
  return catalog.labels.map((l) => ({
    label: l.name,
    type: "property" as const,
    detail: "label",
  }));
}

/** The completions at `pos`, and where the text they replace starts. */
export function logqlCompletions(
  catalog: LogqlCompletionCatalog,
  text: string,
  pos: number,
): { from: number; options: LogqlCompletion[] } | null {
  const context = logqlCompletionContext(text, pos);
  switch (context.kind) {
    case "none":
      return null;
    case "label":
      return { from: context.from, options: labelOptions(catalog) };
    case "value": {
      const label = catalog.labels.find((l) => l.name === context.label);
      if (!label || label.values.length === 0) return null;
      return {
        from: context.from,
        options: label.values.map((value) => {
          const apply = quoted(context.regex ? literalRegex(value) : value);
          return {
            label: value,
            type: "constant" as const,
            detail: `value of ${label.name}`,
            ...(apply === value ? {} : { apply }),
          };
        }),
      };
    }
    case "stage":
      return {
        from: context.from,
        options: [
          ...LOGQL_STAGES.map((s) => ({ label: s, type: "keyword" as const })),
          ...labelOptions(catalog),
        ],
      };
    case "expression":
      return {
        from: context.from,
        options: [
          ...LOGQL_RANGE_FUNCTIONS.map((f) => ({
            label: f,
            type: "function" as const,
            detail: "range",
          })),
          ...LOGQL_AGGREGATIONS.map((f) => ({ label: f, type: "function" as const })),
        ],
      };
  }
}

export interface LogqlDiagnostic {
  from: number;
  to: number;
  severity: "error" | "warning";
  message: string;
}

const NAME = /[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * Where a message points in the text: a name it quotes first (the guard
 * writes `label "pod" is not …`), then any bare name, skipping the
 * functions and stages, which say what, never where.
 */
function rangeOf(text: string, message: string): { from: number; to: number } | null {
  const quotedNames = [...message.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)].map(
    (m) => m[1],
  );
  const skip = new Set([
    ...LOGQL_RANGE_FUNCTIONS,
    ...LOGQL_AGGREGATIONS,
    ...LOGQL_STAGES,
  ]);
  const bare = (message.match(NAME) ?? []).filter((w) => !skip.has(w));
  for (const word of [...quotedNames, ...bare]) {
    // Names are word characters only, so nothing needs escaping.
    const at = new RegExp(`(?<![A-Za-z0-9_])${word}(?![A-Za-z0-9_])`).exec(text);
    if (at) return { from: at.index, to: at.index + word.length };
  }
  return null;
}

/**
 * The guard's verdict as editor diagnostics (#565), as the PromQL editor
 * places its own: a refusal that names a character is placed there, a hint
 * on the first label it names, and anything else underlines the whole
 * expression.
 */
export function logqlDiagnostics(
  text: string,
  verdict: { ok: true; hints?: string[] } | { ok: false; error: string },
): LogqlDiagnostic[] {
  const whole = { from: 0, to: text.length };
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
