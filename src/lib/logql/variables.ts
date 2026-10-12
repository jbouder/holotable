import type { LogqlNode } from "@/lib/logql/parse";
import {
  applySplices,
  reparse,
  type Splice,
  sameSignature,
  signature,
} from "@/lib/logql/rewrite";
import {
  analyzeLogql,
  type LogqlLimits,
  VARIABLE_REF,
  variableSlots,
} from "@/lib/logql/safety";
import { plainString, stringLiteral, text } from "@/lib/promql/parse";
import { type VariableValues, VariableError } from "@/lib/sql/variables";

/**
 * Dashboard variables in LogQL (#67, #561).
 *
 * The guard allows a `:name` reference in two places, each a single plain
 * value: a matcher's whole value with `=` or `!=` (`{env=":env"}`,
 * `| level=":level"`) and a `|=` or `!=` line filter's string
 * (`|= ":needle"`). Never a regex or a pattern: a value there could change
 * what the expression matches structurally, not just which lines.
 *
 * There is no bound parameter in Loki's HTTP API, so the value is written
 * into the text: only a value the caller has already checked against what
 * the dashboard allows (`checkedSelection`), only as an escaped string
 * literal in that one position, and the result is re-parsed and compared
 * with the original tree with exactly those literals replaced. A value can
 * change which lines match, never what the expression is.
 *
 * A multi-value pick is refused: every slot takes one value.
 */

/** The references in an expression's variable slots, each with its name. */
function references(expr: string, root: LogqlNode): { node: LogqlNode; name: string }[] {
  const found: { node: LogqlNode; name: string }[] = [];
  for (const node of variableSlots(expr, root)) {
    const value = plainString(text(expr, node));
    const ref = value === null ? null : VARIABLE_REF.exec(value);
    if (ref) found.push({ node, name: ref[1] });
  }
  return found.sort((a, b) => a.node.from - b.node.from);
}

/**
 * The variables an expression references, in the order they appear, each
 * once: what the plan dialog lists beside the values it bound.
 */
export function logqlVariableNames(expr: string, limits: LogqlLimits): string[] {
  const { root } = analyzeLogql(expr, "bound", limits);
  const names: string[] = [];
  for (const { name } of references(expr, root)) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export function bindLogqlVariables(
  expr: string,
  variables: VariableValues,
  limits: LogqlLimits,
): string {
  // The expression was validated against the dashboard's declared variables
  // before it got here; what is checked now is that each one has a value.
  const { root } = analyzeLogql(expr, "bound", limits);
  const replaced = new Map<LogqlNode, string>();
  const splices: Splice[] = [];
  for (const { node, name } of references(expr, root)) {
    const picked = variables[name];
    if (picked === undefined) throw new VariableError(`no value for variable :${name}`);
    if (typeof picked !== "string") {
      throw new VariableError(
        `variable :${name} takes several values; LogQL takes one value where a variable may appear`,
      );
    }
    const literal = stringLiteral(picked);
    replaced.set(node, literal);
    splices.push({ from: node.from, to: node.to, insert: literal });
  }
  if (splices.length === 0) return expr;

  const out = applySplices(expr, splices);
  const expected = signature(expr, root, { leaf: (node) => replaced.get(node) });
  const actual = signature(out, reparse(out));
  if (!sameSignature(expected, actual)) {
    throw new Error("LogQL variable substitution changed the expression's structure");
  }
  return out;
}
