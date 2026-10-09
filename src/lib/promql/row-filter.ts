import { child, nodes, type PromqlNode, stringLiteral, text } from "@/lib/promql/parse";
import {
  applySplices,
  reparse,
  sameSignature,
  signature,
  type Splice,
} from "@/lib/promql/rewrite";
import { type PromqlLimits, analyzePromql, selectorsOf } from "@/lib/promql/safety";
import { RowFilterError } from "@/lib/sql/row-filter";

/**
 * The tenant matcher (#31, invariant 8a, #384): a Prometheus source's row
 * filter is `{ label, claim }`, and every selector an expression holds,
 * including those inside subqueries and function arguments, is narrowed to
 * `label="<the viewer's claim value>"` before the expression runs.
 *
 * The matcher is spliced at the parser's offsets. A selector that already
 * matches on the label is refused rather than overridden: either it agrees,
 * and is redundant, or it asks for another tenant's series. The result is
 * re-parsed and verified: the same tree once the added matchers are set
 * aside, and every selector carrying exactly one equality matcher on the
 * label, with the value given.
 */

export interface PromqlRowFilterBinding {
  label: string;
  value: string;
}

/** A matcher on the filter's label, wherever it is. */
function isFilterMatcher(expr: string, node: PromqlNode, label: string): boolean {
  if (node.type !== "UnquotedLabelMatcher") return false;
  const name = child(node, "LabelName");
  return name !== undefined && text(expr, name) === label;
}

/**
 * The signature with the filter's matchers set aside, and any braces left
 * holding nothing else: the shape both the original and the rewrite must have.
 */
function withoutFilter(expr: string, root: PromqlNode, label: string): string[] {
  return signature(expr, root, {
    skip: (node) => {
      if (isFilterMatcher(expr, node, label)) return true;
      return (
        node.type === "LabelMatchers" &&
        node.children.every((c) => isFilterMatcher(expr, c, label))
      );
    },
  });
}

export function applyPromqlRowFilter(
  expr: string,
  binding: PromqlRowFilterBinding,
  limits: PromqlLimits,
): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.label) || binding.label.startsWith("__")) {
    throw new Error(`PromQL row filter: "${binding.label}" cannot be a tenant label`);
  }
  // Runs after the variables are bound, so the expression holds values.
  const { root, selectors } = analyzePromql(expr, "bound", limits);
  const literal = stringLiteral(binding.value);
  const matcher = `${binding.label}=${literal}`;
  const splices: Splice[] = [];
  for (const selector of selectors) {
    if (selector.matchers.some((m) => m.label === binding.label)) {
      throw new RowFilterError(
        `this source filters by "${binding.label}" itself; remove that matcher from the query`,
      );
    }
    if (selector.braces) {
      // Before the closing brace, after whatever the braces already hold.
      const close = selector.braces.to - 1;
      const inside = expr.slice(selector.braces.from + 1, close).trimEnd();
      const separator = inside === "" || inside.endsWith(",") ? "" : ", ";
      splices.push({ from: close, to: close, insert: `${separator}${matcher}` });
    } else if (selector.identifier) {
      const at = selector.identifier.to;
      splices.push({ from: at, to: at, insert: `{${matcher}}` });
    } else {
      throw new Error("PromQL row filter: a selector with neither a name nor braces");
    }
  }

  const out = applySplices(expr, splices);
  const rewritten = reparse(out);
  if (
    !sameSignature(
      withoutFilter(expr, root, binding.label),
      withoutFilter(out, rewritten, binding.label),
    )
  ) {
    throw new Error("PromQL row filter changed the expression's structure");
  }
  const after = selectorsOf(out, rewritten);
  if (after.length !== selectors.length) {
    throw new Error("PromQL row filter changed the number of selectors");
  }
  for (const selector of after) {
    const own = selector.matchers.filter((m) => m.label === binding.label);
    if (own.length !== 1 || own[0].op !== "=" || text(out, own[0].value) !== literal) {
      throw new Error("PromQL row filter left a selector unfiltered");
    }
  }
  // Belt and braces: every filter matcher in the tree is one the splice wrote.
  let count = 0;
  for (const { node } of nodes(rewritten)) {
    if (isFilterMatcher(out, node, binding.label)) count++;
  }
  if (count !== selectors.length) {
    throw new Error("PromQL row filter matcher count does not match the selectors");
  }
  return out;
}
