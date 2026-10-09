import { plainString, regexLiteral, stringLiteral, text } from "@/lib/promql/parse";
import {
  applySplices,
  reparse,
  sameSignature,
  signature,
  type Splice,
} from "@/lib/promql/rewrite";
import { type PromqlLimits, analyzePromql, VARIABLE_REF } from "@/lib/promql/safety";
import { type VariableValues, VariableError } from "@/lib/sql/variables";

/**
 * The variables an expression references, in the order they appear, each
 * once: what the plan dialog lists beside the values it bound (#388).
 */
export function promqlVariableNames(expr: string, limits: PromqlLimits): string[] {
  const { selectors } = analyzePromql(expr, "bound", limits);
  const names: string[] = [];
  for (const selector of selectors) {
    for (const matcher of selector.matchers) {
      const value = plainString(text(expr, matcher.value));
      const ref = value === null ? null : VARIABLE_REF.exec(value);
      if (ref && !names.includes(ref[1])) names.push(ref[1]);
    }
  }
  return names;
}

/**
 * Dashboard variables in PromQL (#67, #384).
 *
 * The guard allows a `:name` reference only as a label matcher's whole value,
 * `{host=":host"}`. There is no bound parameter in the Prometheus HTTP API,
 * so here the value is written into the text: only a value the caller has
 * already checked against what the dashboard allows (`checkedSelection`),
 * only as an escaped string literal in that one position, and the result is
 * re-parsed and compared with the original tree with exactly those literals
 * replaced. A value can change which series match, never what the
 * expression is.
 *
 * - `=` and `!=` take one value, written as a string.
 * - `=~` and `!~` take one or several, each regex-escaped, as `^(a|b)$`. A
 *   multi-value pick against `=` or `!=` is refused: it has no meaning there.
 */
export function bindPromqlVariables(
  expr: string,
  variables: VariableValues,
  limits: PromqlLimits,
): string {
  // The expression was validated against the dashboard's declared variables
  // before it got here; what is checked now is that each one has a value.
  const { root, selectors } = analyzePromql(expr, "bound", limits);
  const replaced = new Map<object, string>();
  const splices: Splice[] = [];
  for (const selector of selectors) {
    for (const matcher of selector.matchers) {
      const value = plainString(text(expr, matcher.value));
      const ref = value === null ? null : VARIABLE_REF.exec(value);
      if (!ref) continue;
      const name = ref[1];
      const picked = variables[name];
      if (picked === undefined) throw new VariableError(`no value for variable :${name}`);
      const values = typeof picked === "string" ? [picked] : picked;
      if (values.length === 0) throw new VariableError(`no value for variable :${name}`);
      let literal: string;
      if (matcher.op === "=~" || matcher.op === "!~") {
        literal = stringLiteral(
          values.length === 1
            ? regexLiteral(values[0])
            : `^(${values.map(regexLiteral).join("|")})$`,
        );
      } else if (typeof picked === "string") {
        literal = stringLiteral(picked);
      } else {
        throw new VariableError(
          `variable :${name} takes several values; match it with =~ or !~, not ${matcher.op}`,
        );
      }
      replaced.set(matcher.value, literal);
      splices.push({ from: matcher.value.from, to: matcher.value.to, insert: literal });
    }
  }
  if (splices.length === 0) return expr;

  const out = applySplices(expr, splices);
  const expected = signature(expr, root, { leaf: (node) => replaced.get(node) });
  const actual = signature(out, reparse(out));
  if (!sameSignature(expected, actual)) {
    throw new Error("PromQL variable substitution changed the expression's structure");
  }
  return out;
}
