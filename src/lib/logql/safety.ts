import { config } from "@/lib/config";
import { logqlDurationMs, type LogqlNode, parseLogql, walk } from "@/lib/logql/parse";
import { type LogqlRejectionReason, recordLogqlRejection } from "@/lib/metrics";
import { durationMs, isTerminatedString, plainString, text } from "@/lib/promql/parse";
import { VARIABLE_REF } from "@/lib/promql/safety";

/**
 * The LogQL guard (#561): invariant 7 for a third language. A LogQL
 * expression the model or an author wrote is untrusted exactly as SQL and
 * PromQL are, and is judged on its parse tree, never its text.
 *
 * - **One expression, built only from allowlisted node types.** Pipeline
 *   stages are allowlisted by the grammar node they are, functions and
 *   aggregations by name. Anything the grammar admits that is not listed here
 *   (comments, a stage or function a grammar upgrade adds) is refused until
 *   someone reads it and lists it.
 * - **Every stream selector is anchored on the catalog.** It carries at least
 *   one `=` matcher with a value on a label the source lists, as Loki itself
 *   insists (`{}` and `{app=~".*"}` are refused there; here they are refused
 *   first). A matcher on a label the catalog does not list is a hint.
 * - **Time is the server's.** The grammar has no `@` and no timestamps; a
 *   `[range]` and an `offset` are bounded by `LOGQL_MAX_RANGE`, and an offset
 *   looks back, never forward.
 * - **Variables only where they are one plain value**: a matcher's whole
 *   value with `=` or `!=` (`{env=":env"}`, `| level=":level"`), and the
 *   string of a `|=` or `!=` line filter (`|= ":needle"`). Never inside a
 *   regex or a pattern, where a value could change the expression's
 *   structure. They are substituted after this check, escaped, and the result
 *   is verified by re-parse (`variables.ts`).
 *
 * Pure: it reaches no network, so it is testable to the depth the other
 * guards are.
 */

/** What the guard needs of a Loki source's catalog: its label allowlist. */
export interface LogqlCatalog {
  labels: ReadonlyArray<{ name: string; values?: readonly string[] }>;
}

export interface LogqlLimits {
  /** The longest range or offset, in milliseconds. */
  maxRangeMs: number;
  /** The most stream selectors one expression may hold. */
  maxSelectors: number;
  /** The deepest the parse tree may nest, a list counting once. */
  maxDepth: number;
}

export const LOGQL_MAX_LENGTH = 8_000;

export function defaultLogqlLimits(): LogqlLimits {
  return {
    // Validated at boot (`validateConfig`); the fallback is the documented default.
    maxRangeMs: durationMs(config.logqlMaxRange) ?? 7 * 86_400_000,
    maxSelectors: 32,
    maxDepth: 128,
  };
}

/** A log query returns lines; a metric query returns samples. */
export type LogqlKind = "log" | "metric";

export interface LogqlValidationResult {
  ok: boolean;
  error?: string;
  /**
   * Which class of rule refused the expression. A fixed enum, unlike
   * `error`, which names the label or function and so is attacker-influenced
   * text. Only the reason is safe as a metric label.
   */
  reason?: LogqlRejectionReason;
  /** On acceptance: whether the expression returns log lines or samples. */
  kind?: LogqlKind;
  /**
   * Labels the catalog does not list. Not refusals: Loki answers a matcher
   * on an unknown label with nothing, so the author should hear about it,
   * not be blocked.
   */
  hints?: string[];
}

export { VARIABLE_REF };

export type MatchOperator = "=" | "!=" | "=~" | "!~";

export interface LogqlMatcher {
  node: LogqlNode;
  label: string;
  op: MatchOperator;
  /** The `String` holding the value. */
  value: LogqlNode;
}

export interface LogqlSelector {
  /** The `Selector`: the braces and what they hold. */
  node: LogqlNode;
  matchers: LogqlMatcher[];
}

class Refusal extends Error {
  constructor(
    readonly reason: LogqlRejectionReason,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The node types an expression is built from, outside the pipeline stages
 * and the function names: the two query shapes, selectors and matchers,
 * ranges and offsets, the operators and literals.
 */
const STRUCTURE = new Set([
  "LogQL",
  "Expr",
  "LogExpr",
  "MetricExpr",
  "Selector",
  "Matchers",
  "Matcher",
  "Identifier",
  "String",
  "Number",
  "Duration",
  "Bytes",
  "Eq",
  "Neq",
  "Re",
  "Nre",
  "Gtr",
  "Gte",
  "Lss",
  "Lte",
  "Eql",
  "Add",
  "Sub",
  "Mul",
  "Div",
  "Mod",
  "Pow",
  "And",
  "Or",
  "Unless",
  "Pipe",
  "PipelineExpr",
  "PipelineStage",
  "LiteralExpr",
  // Metric queries.
  "RangeAggregationExpr",
  "RangeOp",
  "LogRangeExpr",
  "Range",
  "OffsetExpr",
  "Offset",
  "VectorAggregationExpr",
  "VectorOp",
  "Grouping",
  "By",
  "Without",
  "Labels",
  "BinOpExpr",
  "BinOpModifier",
  "Bool",
  "OnOrIgnoringModifier",
  "On",
  "Ignoring",
  "GroupLeft",
  "GroupRight",
  "GroupingLabels",
  "GroupingLabelList",
  "GroupingLabel",
  "LabelName",
  "LabelReplaceExpr",
  "LabelReplace",
  "VectorExpr",
  "Vector",
]);

/**
 * The pipeline stages, by the grammar node a `PipelineStage` holds, and what
 * those nodes are built from. Line filters (with `ip()`), the parsers, label
 * filters, `line_format`, `label_format`, `keep`, `drop`, `decolorize`, and
 * `unwrap` with its conversions. None is dangerous to Loki; the point is
 * that the list is the contract, as SQL's node types are.
 */
const STAGES = new Set([
  "LineFilters",
  "LogfmtParser",
  "LabelParser",
  "JsonExpressionParser",
  "LogfmtExpressionParser",
  "LabelFilter",
  "LineFormatExpr",
  "LabelFormatExpr",
  "DecolorizeExpr",
  "DropLabelsExpr",
  "KeepLabelsExpr",
]);

const STAGE_PARTS = new Set([
  ...STAGES,
  "LineFilter",
  "Filter",
  "PipeExact",
  "PipeMatch",
  "PipePattern",
  "Npa",
  "FilterOp",
  "Ip",
  "OrFilter",
  "Json",
  "Logfmt",
  "Unpack",
  "Pattern",
  "Regexp",
  "LogfmtParserFlags",
  "ParserFlag",
  "LabelExtractionExpressionList",
  "LabelExtractionExpression",
  "IpLabelFilter",
  "UnitFilter",
  "DurationFilter",
  "BytesFilter",
  "NumberFilter",
  "LineFormat",
  "LabelFormat",
  "LabelsFormat",
  "LabelFormatMatcher",
  "Decolorize",
  "Drop",
  "DropLabels",
  "DropLabel",
  "Keep",
  "KeepLabels",
  "KeepLabel",
  "UnwrapExpr",
  "Unwrap",
  "ConvOp",
]);

/** Loki's range functions, which turn a log range into samples. */
const RANGE_FUNCTIONS = new Set([
  "CountOverTime",
  "Rate",
  "RateCounter",
  "BytesOverTime",
  "BytesRate",
  "AvgOverTime",
  "SumOverTime",
  "MinOverTime",
  "MaxOverTime",
  "StddevOverTime",
  "StdvarOverTime",
  "QuantileOverTime",
  "FirstOverTime",
  "LastOverTime",
  "AbsentOverTime",
]);

/**
 * The aggregations: PromQL's stable set as LogQL has them. The approximate
 * ones a newer grammar adds are not here: they need a flag the endpoint may
 * not have, and are refused until someone lists them.
 */
const AGGREGATIONS = new Set([
  "Sum",
  "Avg",
  "Count",
  "Max",
  "Min",
  "Stddev",
  "Stdvar",
  "Bottomk",
  "Topk",
  "Sort",
  "Sort_Desc",
]);

/** `unwrap`'s conversions. */
const CONVERSIONS = new Set(["BytesConv", "DurationConv", "DurationSecondsConv"]);

function isAllowed(node: LogqlNode, parent: LogqlNode | null): boolean {
  if (parent?.type === "RangeOp") return RANGE_FUNCTIONS.has(node.type);
  if (parent?.type === "VectorOp") return AGGREGATIONS.has(node.type);
  if (parent?.type === "ConvOp") return CONVERSIONS.has(node.type);
  if (parent?.type === "PipelineStage" && node.type !== "Pipe") {
    return STAGES.has(node.type);
  }
  return STRUCTURE.has(node.type) || STAGE_PARTS.has(node.type);
}

/** Why a node type is refused, in words the author can act on. */
function refusalFor(expr: string, node: LogqlNode, parent: LogqlNode | null): Refusal {
  if (node.type === "LineComment") {
    return new Refusal("structure", "comments are not allowed");
  }
  if (parent?.type === "RangeOp") {
    return new Refusal("function", `function ${text(expr, node)}() is not allowed`);
  }
  if (parent?.type === "VectorOp") {
    return new Refusal("function", `aggregation ${text(expr, node)} is not allowed`);
  }
  if (parent?.type === "ConvOp") {
    return new Refusal("function", `conversion ${text(expr, node)}() is not allowed`);
  }
  if (parent?.type === "PipelineStage") {
    return new Refusal(
      "stage",
      `the pipeline stage "${text(expr, node).slice(0, 40)}" is not allowed`,
    );
  }
  return new Refusal(
    "structure",
    `"${text(expr, node).slice(0, 40)}" is not supported in a panel query`,
  );
}

const OPERATORS: Record<string, MatchOperator> = {
  Eq: "=",
  Neq: "!=",
  Re: "=~",
  Nre: "!~",
};

/** A `Matcher` node: `label op "value"`, wherever it is. */
function matcherOf(expr: string, node: LogqlNode): LogqlMatcher {
  const [label, op, value] = node.children;
  const operator = op ? OPERATORS[op.type] : undefined;
  if (
    node.children.length !== 3 ||
    label.type !== "Identifier" ||
    !operator ||
    value.type !== "String"
  ) {
    throw new Refusal("structure", "a label matcher is not well formed");
  }
  return { node, label: text(expr, label), op: operator, value };
}

/** Every stream selector, with its matchers, including those nested in a metric query. */
export function selectorsOf(expr: string, root: LogqlNode): LogqlSelector[] {
  const found: LogqlSelector[] = [];
  for (const { node } of walk(root)) {
    if (node.type !== "Selector") continue;
    const matchers: LogqlMatcher[] = [];
    for (const { node: item, parent } of walk(node)) {
      if (item.type === "Matcher" && parent?.type === "Matchers") {
        matchers.push(matcherOf(expr, item));
      }
    }
    found.push({ node, matchers });
  }
  return found;
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

function durationOf(expr: string, node: LogqlNode): number {
  const literal = node.children;
  if (literal.length === 1 && literal[0].type === "Duration") {
    const ms = logqlDurationMs(text(expr, literal[0]));
    if (ms !== null) return ms;
  }
  throw new Refusal("structure", `"${text(expr, node)}" is not a plain duration`);
}

function checkDurations(expr: string, root: LogqlNode, limits: LogqlLimits): void {
  const tooLong = (what: string, ms: number) =>
    new Refusal(
      "time",
      `${what} of ${formatMs(ms)} is longer than the ${formatMs(limits.maxRangeMs)} this server allows`,
    );
  for (const { node } of walk(root)) {
    if (node.type === "Range") {
      const ms = durationOf(expr, node);
      if (ms <= 0) throw new Refusal("structure", "a range must be longer than zero");
      if (ms > limits.maxRangeMs) throw tooLong("a range", ms);
    } else if (node.type === "OffsetExpr") {
      const duration = node.children.find((c) => c.type === "Duration");
      const ms = duration ? logqlDurationMs(text(expr, duration)) : null;
      if (ms === null) throw new Refusal("structure", "an offset needs a duration");
      if (ms < 0) {
        throw new Refusal(
          "time",
          "a negative offset reads past the end of the window: the server owns the time of every query",
        );
      }
      if (ms > limits.maxRangeMs) throw tooLong("an offset", ms);
    }
  }
}

/**
 * The strings a variable may be: a matcher's whole value with `=` or `!=`
 * (in a stream selector or a label filter), and a `|=` or `!=` line filter's
 * string. Not an `ip()` argument, not an `or` alternative, and never a
 * regex or a pattern.
 */
export function variableSlots(expr: string, root: LogqlNode): Set<LogqlNode> {
  const slots = new Set<LogqlNode>();
  for (const { node, parent } of walk(root)) {
    if (
      node.type === "Matcher" &&
      (parent?.type === "Matchers" || parent?.type === "LabelFilter")
    ) {
      const { op, value } = matcherOf(expr, node);
      if (op === "=" || op === "!=") slots.add(value);
    } else if (node.type === "LineFilter") {
      const [filter, literal] = node.children;
      const op = filter?.children[0]?.type;
      if (literal?.type === "String" && (op === "PipeExact" || op === "Neq")) {
        slots.add(literal);
      }
    }
  }
  return slots;
}

/** The line-filter operators that take a regex or a pattern. */
const PATTERN_FILTERS = new Set(["PipeMatch", "Nre", "PipePattern", "Npa"]);

/**
 * The operator each line-filter string is matched with. An `or` alternative
 * (`|~ "a" or "b"`) has none of its own: it takes the operator of the filter
 * it follows, which sits beside it in a `LineFilter` or a `LineFilters`.
 */
function lineFilterOperators(root: LogqlNode): Map<LogqlNode, string> {
  const operators = new Map<LogqlNode, string>();
  for (const { node } of walk(root)) {
    if (node.type !== "LineFilter" && node.type !== "LineFilters") continue;
    let op: string | undefined;
    for (const item of node.children) {
      if (item.type === "Filter") op = item.children[0]?.type;
      else if (item.type === "LineFilter") op = item.children[0]?.children[0]?.type;
      if (op === undefined) continue;
      if (item.type === "String" && node.type === "LineFilter") operators.set(item, op);
      if (item.type === "OrFilter") {
        for (const { node: inner } of walk(item)) {
          if (inner.type === "String") operators.set(inner, op);
        }
      }
    }
  }
  return operators;
}

/** Whether a string holds a regex or a pattern. */
function isRegexOrPattern(
  node: LogqlNode,
  parent: LogqlNode | null,
  operators: ReadonlyMap<LogqlNode, string>,
): boolean {
  if (PATTERN_FILTERS.has(operators.get(node) ?? "")) return true;
  if (parent?.type === "Matcher") {
    const op = parent.children[1]?.type;
    return op === "Re" || op === "Nre";
  }
  if (parent?.type === "LabelParser") {
    const kind = parent.children[0]?.type;
    return kind === "Regexp" || kind === "Pattern";
  }
  return false;
}

function checkVariables(
  expr: string,
  root: LogqlNode,
  declared: ReadonlySet<string> | "bound",
): void {
  // An expression whose variables are already bound holds values, not
  // references: a picked value may itself look like one.
  if (declared === "bound") return;
  const slots = variableSlots(expr, root);
  const operators = lineFilterOperators(root);
  for (const { node, parent } of walk(root)) {
    if (node.type === "Identifier" && VARIABLE_REF.test(text(expr, node))) {
      throw new Refusal(
        "variable",
        "a variable may appear only as a value, not as a label name or a field",
      );
    }
    if (node.type !== "String") continue;
    const value = plainString(text(expr, node));
    const ref = value === null ? null : VARIABLE_REF.exec(value);
    if (!ref) continue;
    if (slots.has(node)) {
      if (!declared.has(ref[1])) {
        throw new Refusal(
          "variable",
          `variable :${ref[1]} is not declared on this dashboard`,
        );
      }
      continue;
    }
    if (isRegexOrPattern(node, parent, operators)) {
      throw new Refusal(
        "variable",
        `${value} cannot be used inside a regex or a pattern: a value there could change what the expression is`,
      );
    }
    throw new Refusal(
      "variable",
      `${value} may appear only as a matcher's whole value, such as {env="${value}"}, or as a line filter's string, such as |= "${value}"`,
    );
  }
}

/**
 * A metric query's operands are metric queries. The grammar lets a log query
 * stand beside an operator; Loki refuses it, and so does the guard, so that
 * every expression is plainly one kind or the other.
 */
function checkOperands(root: LogqlNode): void {
  for (const { node } of walk(root)) {
    if (node.type !== "BinOpExpr") continue;
    for (const operand of node.children) {
      if (operand.type === "Expr" && operand.children[0]?.type === "LogExpr") {
        throw new Refusal(
          "structure",
          "a log query cannot be an operand of a binary operator; wrap it in a range function such as count_over_time",
        );
      }
    }
  }
}

function kindOf(root: LogqlNode): LogqlKind {
  const top = root.children[0]?.children[0];
  if (top?.type === "LogExpr") return "log";
  if (top?.type === "MetricExpr") return "metric";
  throw new Refusal("structure", "the query is neither a log nor a metric query");
}

export interface LogqlAnalysis {
  root: LogqlNode;
  selectors: LogqlSelector[];
  kind: LogqlKind;
}

/**
 * Parse and check everything that does not depend on the catalog. Throws a
 * {@link Refusal}; exported for the rewrites, which re-run it on what they
 * produce.
 */
export function analyzeLogql(
  expr: string,
  /** The declared variable names, or `"bound"` once their values are in. */
  declared: ReadonlySet<string> | "bound",
  limits: LogqlLimits,
): LogqlAnalysis {
  if (expr.trim() === "") throw new Refusal("empty", "the query is empty");
  if (expr.length > LOGQL_MAX_LENGTH) {
    throw new Refusal(
      "bounds",
      `the query is longer than ${LOGQL_MAX_LENGTH} characters`,
    );
  }
  const parsed = parseLogql(expr);
  if (!parsed.ok) throw new Refusal("structure", parsed.error);
  const { root } = parsed;
  for (const { node, parent, nesting } of walk(root)) {
    if (nesting > limits.maxDepth) {
      throw new Refusal(
        "bounds",
        `the query nests deeper than ${limits.maxDepth} levels`,
      );
    }
    if (!isAllowed(node, parent)) throw refusalFor(expr, node, parent);
    if (node.type === "String" && !isTerminatedString(text(expr, node))) {
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
      `the query has more than ${limits.maxSelectors} stream selectors`,
    );
  }
  checkOperands(root);
  checkDurations(expr, root, limits);
  checkVariables(expr, root, declared);
  return { root, selectors, kind: kindOf(root) };
}

/**
 * Every selector anchored on the catalog: an `=` matcher with a value on a
 * listed label. A variable's reference counts as a value; once bound, the
 * check runs again on what it was bound to (`plan.ts`).
 */
export function checkAnchors(
  expr: string,
  selectors: readonly LogqlSelector[],
  catalog: LogqlCatalog,
): void {
  const listed = new Set(catalog.labels.map((l) => l.name));
  for (const selector of selectors) {
    const anchored = selector.matchers.some(
      (m) => m.op === "=" && listed.has(m.label) && text(expr, m.value).length > 2,
    );
    if (!anchored) {
      throw new Refusal(
        "catalog",
        'every stream selector needs an "=" matcher with a value on a label this source lists, such as {app="api"}',
      );
    }
  }
}

function catalogHints(
  selectors: readonly LogqlSelector[],
  catalog: LogqlCatalog,
): string[] {
  const listed = new Set(catalog.labels.map((l) => l.name));
  const hints = new Set<string>();
  for (const selector of selectors) {
    for (const matcher of selector.matchers) {
      if (!listed.has(matcher.label)) {
        hints.add(`no label "${matcher.label}" in this source's catalog`);
      }
    }
  }
  return [...hints];
}

/** Refuse, count and describe; the one way a validation ends in a refusal. */
function refuse(err: unknown): LogqlValidationResult {
  if (err instanceof Refusal) {
    recordLogqlRejection(err.reason);
    return { ok: false, error: err.message, reason: err.reason };
  }
  // Anything else is a bug in the guard; it still refuses.
  recordLogqlRejection("structure");
  return { ok: false, error: "the query could not be checked", reason: "structure" };
}

/**
 * Validate one expression against a source's label allowlist, with the
 * dashboard's declared variables. Never throws.
 */
export function validateLogql(
  expr: string,
  catalog: LogqlCatalog,
  declared: ReadonlySet<string> = new Set(),
  limits: LogqlLimits = defaultLogqlLimits(),
): LogqlValidationResult {
  try {
    const { selectors, kind } = analyzeLogql(expr, declared, limits);
    checkAnchors(expr, selectors, catalog);
    const hints = catalogHints(selectors, catalog);
    return hints.length > 0 ? { ok: true, kind, hints } : { ok: true, kind };
  } catch (err) {
    return refuse(err);
  }
}

/**
 * A label-values variable's query against a Loki source: the label, which
 * must be one the catalog lists, and an optional `match` that must be
 * exactly one anchored stream selector, with no pipeline, range or variable
 * around it. Never throws.
 */
export function validateLogqlLabelValues(
  query: { label: string; match?: string },
  catalog: LogqlCatalog,
  limits: LogqlLimits = defaultLogqlLimits(),
): LogqlValidationResult {
  try {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(query.label)) {
      throw new Refusal("structure", `"${query.label}" is not a label name`);
    }
    if (!catalog.labels.some((l) => l.name === query.label)) {
      throw new Refusal(
        "catalog",
        `label "${query.label}" is not in this source's catalog`,
      );
    }
    if (query.match === undefined) return { ok: true };
    const { root, selectors } = analyzeLogql(query.match, new Set(), limits);
    const only = root.children[0]?.children[0];
    if (only?.type !== "LogExpr" || only.children.length !== 1) {
      throw new Refusal(
        "structure",
        'a label-values match is one stream selector, such as {app="api"}',
      );
    }
    if (only.children[0].type !== "Selector") {
      throw new Refusal(
        "structure",
        'a label-values match is one stream selector, such as {app="api"}',
      );
    }
    checkAnchors(query.match, selectors, catalog);
    return { ok: true };
  } catch (err) {
    return refuse(err);
  }
}

export { Refusal as LogqlRefusal };
