import { config } from "@/lib/config";
import { type PromqlRejectionReason, recordPromqlRejection } from "@/lib/metrics";
import {
  child,
  durationMs,
  isTerminatedString,
  nodes,
  type PromqlNode,
  parsePromql,
  plainString,
  text,
} from "@/lib/promql/parse";

/**
 * The PromQL guard (#384): invariant 7 for a second language. A PromQL
 * expression the model or an author wrote is untrusted exactly as SQL is, and
 * is judged on its parse tree, never its text.
 *
 * - **One expression, built only from allowlisted node types.** Anything the
 *   grammar admits that is not listed here (the `@` modifier, experimental
 *   modifiers and functions, comments, duration arithmetic) is refused, so a
 *   grammar upgrade that adds a construct adds a refusal until someone reads it.
 * - **Every selector names exactly one metric, and it is on the allowlist**,
 *   as the bare name, a quoted name, or a `__name__="…"` matcher. A selector
 *   without one, or a `__name__` matched any other way, could read every
 *   series the endpoint has.
 * - **Time is the server's.** `@` is refused; a range, a subquery range and an
 *   offset are each bounded by `PROMQL_MAX_RANGE`.
 * - **Variables only as whole label-matcher values**, `{host=":host"}`, and
 *   declared. They are substituted after this check, escaped, and the result
 *   is verified by re-parse (`variables.ts`).
 *
 * Pure: it reaches no network, so it is testable to the depth the SQL guard is.
 */

/** What the guard needs of a Prometheus source's catalog: its metric allowlist. */
export interface PromqlCatalog {
  metrics: ReadonlyArray<{ name: string; labels?: readonly string[] }>;
}

export interface PromqlLimits {
  /** The longest range, subquery range or offset, in milliseconds. */
  maxRangeMs: number;
  /** The most selectors one expression may hold. */
  maxSelectors: number;
  /** The deepest the parse tree may nest. */
  maxDepth: number;
  /** The most points a subquery may evaluate. */
  maxSubqueryPoints: number;
}

export const PROMQL_MAX_LENGTH = 8_000;

export function defaultLimits(): PromqlLimits {
  return {
    maxRangeMs: config.promqlMaxRangeMs,
    maxSelectors: 32,
    maxDepth: 64,
    maxSubqueryPoints: 11_000,
  };
}

export interface PromqlValidationResult {
  ok: boolean;
  error?: string;
  /**
   * Which class of rule refused the expression. A fixed enum, unlike
   * `error`, which names the metric or function and so is attacker-influenced
   * text. Only the reason is safe as a metric label.
   */
  reason?: PromqlRejectionReason;
  /**
   * Labels the catalog does not list for the metrics they are used with.
   * Not refusals: Prometheus answers an unknown label with an empty result,
   * so the author should hear about it, not be blocked.
   */
  hints?: string[];
}

/** The `:name` of a variable reference, in the IR's own shape. */
export const VARIABLE_REF = /^:([a-z][a-z0-9_]{0,31})$/;

export type MatchOperator = "=" | "!=" | "=~" | "!~";

export interface Matcher {
  node: PromqlNode;
  label: string;
  op: MatchOperator;
  /** The `StringLiteral` holding the value. */
  value: PromqlNode;
}

export interface Selector {
  node: PromqlNode;
  metric: string;
  /** The `{…}`, when the selector has braces. */
  braces?: PromqlNode;
  /** The bare metric name, when it is written before any braces. */
  identifier?: PromqlNode;
  matchers: Matcher[];
}

class Refusal extends Error {
  constructor(
    readonly reason: PromqlRejectionReason,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The node types an expression may be built from. Structure, the operators,
 * the matchers, durations as literals, and the standard functions and
 * aggregations. Everything else is refused by default.
 */
const STRUCTURE = new Set([
  "PromQL",
  "ParenExpr",
  "UnaryExpr",
  "UnaryOp",
  "BinaryExpr",
  "BoolModifier",
  "Bool",
  "MatchingModifierClause",
  "On",
  "Ignoring",
  "GroupLeft",
  "GroupRight",
  "GroupingLabels",
  "LabelName",
  "AggregateExpr",
  "AggregateOp",
  "AggregateModifier",
  "By",
  "Without",
  "FunctionCall",
  "FunctionIdentifier",
  "FunctionCallBody",
  "NumberDurationLiteral",
  "StringLiteral",
  "VectorSelector",
  "Identifier",
  "LabelMatchers",
  "UnquotedLabelMatcher",
  "QuotedLabelName",
  "MatchOp",
  "EqlSingle",
  "EqlRegex",
  "NeqRegex",
  "MatrixSelector",
  "SubqueryExpr",
  "DurationExpr",
  "OffsetExpr",
  "Offset",
  "OffsetDurationExpr",
  "NumberDurationLiteralInDurationContext",
  // Binary operators.
  "Pow",
  "Mul",
  "Div",
  "Mod",
  "Add",
  "Sub",
  "Eql",
  "Neq",
  "Gte",
  "Gtr",
  "Lte",
  "Lss",
  "And",
  "Or",
  "Unless",
  "Atan2",
]);

const AGGREGATIONS = new Set([
  "Avg",
  "Bottomk",
  "Count",
  "CountValues",
  "Group",
  "Max",
  "Min",
  "Quantile",
  "Stddev",
  "Stdvar",
  "Sum",
  "Topk",
]);

/**
 * The functions an expression may call: the stable set. `info()` is not
 * here because it joins in `target_info` series the expression never names,
 * which would read a metric past the allowlist; the experimental functions
 * are not here because they need a feature flag the endpoint may not have.
 */
const FUNCTIONS = new Set([
  "Abs",
  "Absent",
  "AbsentOverTime",
  "Acos",
  "Acosh",
  "Asin",
  "Asinh",
  "Atan",
  "Atanh",
  "AvgOverTime",
  "Ceil",
  "Changes",
  "Clamp",
  "ClampMax",
  "ClampMin",
  "Cos",
  "Cosh",
  "CountOverTime",
  "DayOfMonth",
  "DayOfWeek",
  "DayOfYear",
  "DaysInMonth",
  "Deg",
  "Delta",
  "Deriv",
  "DoubleExponentialSmoothing",
  "Exp",
  "Floor",
  "HistogramAvg",
  "HistogramCount",
  "HistogramFraction",
  "HistogramQuantile",
  "HistogramStdDev",
  "HistogramStdVar",
  "HistogramSum",
  "Hour",
  "Idelta",
  "Increase",
  "Irate",
  "LabelJoin",
  "LabelReplace",
  "LastOverTime",
  "Ln",
  "Log10",
  "Log2",
  "MadOverTime",
  "MaxOverTime",
  "MinOverTime",
  "Minute",
  "Month",
  "Pi",
  "PredictLinear",
  "PresentOverTime",
  "QuantileOverTime",
  "Rad",
  "Rate",
  "Resets",
  "Round",
  "Scalar",
  "Sgn",
  "Sin",
  "Sinh",
  "Sort",
  "SortByLabel",
  "SortByLabelDesc",
  "SortDesc",
  "Sqrt",
  "StddevOverTime",
  "StdvarOverTime",
  "SumOverTime",
  "Tan",
  "Tanh",
  "Time",
  "Timestamp",
  "Vector",
  "Year",
]);

/** The server's time words: `@` and what can follow it. */
const TIME_WORDS = new Set([
  "StepInvariantExpr",
  "At",
  "AtModifierPreprocessors",
  "AtStart",
  "AtEnd",
  "StartFn",
  "EndFn",
  "DurationStep",
  "DurationRange",
]);

function isAllowed(node: PromqlNode, parent: PromqlNode | null): boolean {
  if (STRUCTURE.has(node.type)) return true;
  if (parent?.type === "AggregateOp") return AGGREGATIONS.has(node.type);
  if (parent?.type === "FunctionIdentifier") return FUNCTIONS.has(node.type);
  return false;
}

/** Why a node type is refused, in words the author can act on. */
function refusalFor(expr: string, node: PromqlNode, parent: PromqlNode | null): Refusal {
  if (TIME_WORDS.has(node.type)) {
    return new Refusal(
      "time",
      "the @ modifier is not allowed: the server owns the time of every query",
    );
  }
  if (node.type === "LineComment") {
    return new Refusal("structure", "comments are not allowed");
  }
  if (parent?.type === "FunctionIdentifier") {
    return new Refusal("function", `function ${text(expr, node)}() is not allowed`);
  }
  if (parent?.type === "AggregateOp") {
    return new Refusal("function", `aggregation ${text(expr, node)} is not allowed`);
  }
  if (node.type === "QuotedLabelMatcher") {
    return new Refusal("structure", "quoted label names are not supported in a matcher");
  }
  return new Refusal(
    "structure",
    `"${text(expr, node).slice(0, 40)}" is not supported in a panel query`,
  );
}

const OPERATORS: Record<string, MatchOperator> = {
  EqlSingle: "=",
  Neq: "!=",
  EqlRegex: "=~",
  NeqRegex: "!~",
};

function matcherOf(expr: string, node: PromqlNode): Matcher {
  const label = child(node, "LabelName");
  const op = child(node, "MatchOp")?.children[0];
  const value = child(node, "StringLiteral");
  const operator = op ? OPERATORS[op.type] : undefined;
  if (!label || !operator || !value) {
    throw new Refusal("structure", "a label matcher is not well formed");
  }
  return { node, label: text(expr, label), op: operator, value };
}

/**
 * Every vector selector, with the one metric it names. Refuses a selector
 * that names none, names one more than once, or names it any way but plainly.
 */
export function selectorsOf(expr: string, root: PromqlNode): Selector[] {
  const found: Selector[] = [];
  for (const { node } of nodes(root)) {
    if (node.type !== "VectorSelector") continue;
    const identifier = child(node, "Identifier");
    const braces = child(node, "LabelMatchers");
    const names: string[] = [];
    if (identifier) names.push(text(expr, identifier));
    const matchers: Matcher[] = [];
    for (const item of braces?.children ?? []) {
      if (item.type === "QuotedLabelName") {
        const literal = child(item, "StringLiteral");
        const name = literal ? plainString(text(expr, literal)) : null;
        if (name === null) {
          throw new Refusal("catalog", "a quoted metric name must be a plain string");
        }
        names.push(name);
      } else if (item.type === "UnquotedLabelMatcher") {
        const matcher = matcherOf(expr, item);
        if (matcher.label === "__name__") {
          if (matcher.op !== "=") {
            throw new Refusal(
              "catalog",
              `__name__ may only be matched with "=": a pattern could read any metric`,
            );
          }
          const name = plainString(text(expr, matcher.value));
          if (name === null) {
            throw new Refusal("catalog", "a __name__ matcher must be a plain string");
          }
          names.push(name);
        } else {
          matchers.push(matcher);
        }
      }
    }
    if (names.length === 0) {
      throw new Refusal("catalog", "every selector must name a metric");
    }
    if (names.length > 1) {
      throw new Refusal("catalog", "a selector names its metric once");
    }
    found.push({ node, metric: names[0], braces, identifier, matchers });
  }
  return found;
}

/** A duration node's length, refusing anything but a single literal. */
function durationOf(expr: string, node: PromqlNode): number {
  const literal = node.children;
  if (
    literal.length === 1 &&
    literal[0].type === "NumberDurationLiteralInDurationContext"
  ) {
    const ms = durationMs(text(expr, literal[0]));
    if (ms !== null) return ms;
  }
  if (
    node.type === "OffsetDurationExpr" &&
    literal.length === 2 &&
    literal[0].type === "UnaryOp" &&
    literal[1].type === "OffsetDurationExpr"
  ) {
    return durationOf(expr, literal[1]);
  }
  throw new Refusal("structure", `"${text(expr, node)}" is not a plain duration`);
}

function formatMs(ms: number): string {
  const units: [number, string][] = [
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "m"],
    [1_000, "s"],
  ];
  for (const [size, unit] of units) if (ms % size === 0) return `${ms / size}${unit}`;
  return `${ms}ms`;
}

function checkDurations(expr: string, root: PromqlNode, limits: PromqlLimits): void {
  const tooLong = (what: string, ms: number) =>
    new Refusal(
      "time",
      `${what} of ${formatMs(ms)} is longer than the ${formatMs(limits.maxRangeMs)} this server allows`,
    );
  for (const { node } of nodes(root)) {
    if (node.type === "MatrixSelector") {
      const range = child(node, "DurationExpr");
      if (!range) throw new Refusal("structure", "a range selector needs a range");
      const ms = durationOf(expr, range);
      if (ms <= 0) throw new Refusal("structure", "a range must be longer than zero");
      if (ms > limits.maxRangeMs) throw tooLong("a range", ms);
    } else if (node.type === "SubqueryExpr") {
      const [range, step] = node.children.filter((c) => c.type === "DurationExpr");
      if (!range) throw new Refusal("structure", "a subquery needs a range");
      const rangeMs = durationOf(expr, range);
      if (rangeMs <= 0)
        throw new Refusal("structure", "a range must be longer than zero");
      if (rangeMs > limits.maxRangeMs) throw tooLong("a subquery range", rangeMs);
      if (step) {
        const stepMs = durationOf(expr, step);
        if (stepMs < 1_000) {
          throw new Refusal("time", "a subquery step must be at least 1s");
        }
        if (rangeMs / stepMs > limits.maxSubqueryPoints) {
          throw new Refusal(
            "time",
            `a subquery of ${formatMs(rangeMs)} at ${formatMs(stepMs)} evaluates more than ${limits.maxSubqueryPoints} points`,
          );
        }
      }
    } else if (node.type === "OffsetExpr") {
      const offset = child(node, "OffsetDurationExpr");
      if (!offset) throw new Refusal("structure", "an offset needs a duration");
      const ms = durationOf(expr, offset);
      if (ms > limits.maxRangeMs) throw tooLong("an offset", ms);
    }
  }
}

/**
 * Where variables may be: the value of a label matcher, whole. Every other
 * string, metric name and label that has the shape of one is refused, so a
 * reference cannot be written somewhere its value would change the meaning
 * of the expression rather than which series it selects.
 */
function checkVariables(
  expr: string,
  root: PromqlNode,
  selectors: Selector[],
  declared: ReadonlySet<string> | "bound",
): void {
  // An expression whose variables are already bound holds values, not
  // references: a picked value may itself look like one.
  if (declared === "bound") return;
  const allowed = new Set<PromqlNode>();
  for (const selector of selectors) {
    if (VARIABLE_REF.test(selector.metric)) {
      throw new Refusal(
        "variable",
        "a variable may appear only as a label matcher's value, not as a metric name",
      );
    }
    for (const matcher of selector.matchers) {
      const value = plainString(text(expr, matcher.value));
      const ref = value === null ? null : VARIABLE_REF.exec(value);
      if (!ref) continue;
      if (!declared.has(ref[1])) {
        throw new Refusal(
          "variable",
          `variable :${ref[1]} is not declared on this dashboard`,
        );
      }
      allowed.add(matcher.value);
    }
  }
  for (const { node } of nodes(root)) {
    if (node.type !== "StringLiteral" || allowed.has(node)) continue;
    const value = plainString(text(expr, node));
    if (value !== null && VARIABLE_REF.test(value)) {
      throw new Refusal(
        "variable",
        `${value} may appear only as a label matcher's whole value, such as {host="${value}"}`,
      );
    }
  }
}

/** Labels the catalog does not list for the metrics an expression reads. */
function catalogHints(
  expr: string,
  root: PromqlNode,
  selectors: Selector[],
  catalog: PromqlCatalog,
): string[] {
  const labelsOf = new Map(catalog.metrics.map((m) => [m.name, m.labels]));
  const hints = new Set<string>();
  const everyLabel = new Set<string>();
  let listed = false;
  for (const selector of selectors) {
    const labels = labelsOf.get(selector.metric);
    if (!labels) continue;
    listed = true;
    for (const l of labels) everyLabel.add(l);
    for (const matcher of selector.matchers) {
      if (!labels.includes(matcher.label)) {
        hints.add(`${selector.metric} has no label "${matcher.label}" in the catalog`);
      }
    }
  }
  if (listed) {
    for (const { node } of nodes(root)) {
      if (node.type !== "GroupingLabels") continue;
      for (const label of node.children.filter((c) => c.type === "LabelName")) {
        const name = text(expr, label);
        if (!everyLabel.has(name)) {
          hints.add(`no metric this query reads has a label "${name}" in the catalog`);
        }
      }
    }
  }
  return [...hints];
}

export interface PromqlAnalysis {
  root: PromqlNode;
  selectors: Selector[];
}

/**
 * Parse and check everything that does not depend on the catalog. Throws a
 * {@link Refusal}; exported for the rewrites, which re-run it on what they
 * produce.
 */
export function analyzePromql(
  expr: string,
  /** The declared variable names, or `"bound"` once their values are in. */
  declared: ReadonlySet<string> | "bound",
  limits: PromqlLimits,
): PromqlAnalysis {
  if (expr.trim() === "") throw new Refusal("empty", "the query is empty");
  if (expr.length > PROMQL_MAX_LENGTH) {
    throw new Refusal(
      "bounds",
      `the query is longer than ${PROMQL_MAX_LENGTH} characters`,
    );
  }
  const parsed = parsePromql(expr);
  if (!parsed.ok) throw new Refusal("structure", parsed.error);
  const { root } = parsed;
  for (const { node, depth, parent } of nodes(root)) {
    if (depth > limits.maxDepth) {
      throw new Refusal(
        "bounds",
        `the query nests deeper than ${limits.maxDepth} levels`,
      );
    }
    if (!isAllowed(node, parent)) throw refusalFor(expr, node, parent);
    if (node.type === "StringLiteral" && !isTerminatedString(text(expr, node))) {
      throw new Refusal(
        "structure",
        `a string at character ${node.from + 1} is not closed`,
      );
    }
  }
  const selectors = selectorsOf(expr, root);
  if (selectors.length > limits.maxSelectors) {
    throw new Refusal(
      "bounds",
      `the query has more than ${limits.maxSelectors} selectors`,
    );
  }
  checkDurations(expr, root, limits);
  checkVariables(expr, root, selectors, declared);
  return { root, selectors };
}

/**
 * Validate one expression against a source's metric allowlist, with the
 * dashboard's declared variables. Never throws.
 */
export function validatePromql(
  expr: string,
  catalog: PromqlCatalog,
  declared: ReadonlySet<string> = new Set(),
  limits: PromqlLimits = defaultLimits(),
): PromqlValidationResult {
  try {
    const { root, selectors } = analyzePromql(expr, declared, limits);
    const allowed = new Set(catalog.metrics.map((m) => m.name));
    for (const selector of selectors) {
      if (!allowed.has(selector.metric)) {
        throw new Refusal(
          "catalog",
          `metric "${selector.metric}" is not in this source's catalog`,
        );
      }
    }
    const hints = catalogHints(expr, root, selectors, catalog);
    return hints.length > 0 ? { ok: true, hints } : { ok: true };
  } catch (err) {
    if (err instanceof Refusal) {
      recordPromqlRejection(err.reason);
      return { ok: false, error: err.message, reason: err.reason };
    }
    // Anything else is a bug in the guard; it still refuses.
    recordPromqlRejection("structure");
    return { ok: false, error: "the query could not be checked", reason: "structure" };
  }
}

/**
 * A label-values variable's query (#383): the label's name, and an optional
 * `match` that must be exactly one series selector, on the allowlist, with no
 * function, operator, range or variable around it. Never throws.
 */
export function validatePromqlLabelValues(
  query: { label: string; match?: string },
  catalog: PromqlCatalog,
  limits: PromqlLimits = defaultLimits(),
): PromqlValidationResult {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(query.label)) {
    recordPromqlRejection("structure");
    return {
      ok: false,
      error: `"${query.label}" is not a label name`,
      reason: "structure",
    };
  }
  if (query.match === undefined) return { ok: true };
  const result = validatePromql(query.match, catalog, new Set(), limits);
  if (!result.ok) return result;
  const parsed = parsePromql(query.match);
  const only = parsed.ok ? parsed.root.children : [];
  if (only.length !== 1 || only[0].type !== "VectorSelector") {
    recordPromqlRejection("structure");
    return {
      ok: false,
      error: 'a label-values match is one series selector, such as up{job="api"}',
      reason: "structure",
    };
  }
  return result;
}

export { Refusal as PromqlRefusal };
