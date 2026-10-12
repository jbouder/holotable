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
  type LogqlCatalog,
  type LogqlLimits,
  selectorsOf,
} from "@/lib/logql/safety";
import { stringLiteral, text } from "@/lib/promql/parse";
import { RowFilterError } from "@/lib/sql/row-filter";

/**
 * The tenant matcher (#31, invariant 8a, #561): a Loki source's row filter
 * is `{ label, claim }`, and every stream selector an expression holds,
 * including those inside range functions and on both sides of a binary
 * operator, is narrowed to `label="<the viewer's claim value>"` before the
 * expression runs.
 *
 * The matcher is spliced before each selector's closing brace, at the
 * parser's offsets. A selector that already matches on the label is refused
 * rather than overridden: either it agrees, and is redundant, or it asks for
 * another tenant's streams. The result is re-parsed and verified: the same
 * tree once the added matchers are set aside, and every selector carrying
 * exactly one equality matcher on the label, with the value given.
 *
 * Only stream selectors are narrowed. A label filter later in the pipeline
 * (`| tenant="x"`) narrows lines already read from the tenant's streams, and
 * cannot widen them.
 */

export interface LogqlRowFilterBinding {
  label: string;
  value: string;
}

/** A stream selector's matcher on the filter's label. */
function isFilterMatcher(
  expr: string,
  node: LogqlNode,
  parent: LogqlNode | null,
  label: string,
): boolean {
  if (node.type !== "Matcher" || parent?.type !== "Matchers") return false;
  const name = node.children[0];
  return name?.type === "Identifier" && text(expr, name) === label;
}

function withoutFilter(expr: string, root: LogqlNode, label: string): string[] {
  return signature(expr, root, {
    skip: (node, parent) => isFilterMatcher(expr, node, parent, label),
  });
}

export function applyLogqlRowFilter(
  expr: string,
  binding: LogqlRowFilterBinding,
  catalog: LogqlCatalog,
  limits: LogqlLimits,
): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.label) || binding.label.startsWith("__")) {
    throw new Error(`LogQL row filter: "${binding.label}" cannot be a tenant label`);
  }
  // A label off the allowlist would narrow to streams the source never
  // meant to expose by that name; the admin lists the tenant label too.
  if (!catalog.labels.some((l) => l.name === binding.label)) {
    throw new RowFilterError(
      `this source filters by "${binding.label}", which its catalog does not list`,
    );
  }
  // `label=""` matches the streams without the label: every other tenant's.
  if (binding.value === "") {
    throw new RowFilterError(`no value to filter "${binding.label}" by`);
  }
  // Runs after the variables are bound, so the expression holds values.
  const { root, selectors } = analyzeLogql(expr, "bound", limits);
  const literal = stringLiteral(binding.value);
  const splices: Splice[] = [];
  for (const selector of selectors) {
    if (selector.matchers.some((m) => m.label === binding.label)) {
      throw new RowFilterError(
        `this source filters by "${binding.label}" itself; remove that matcher from the query`,
      );
    }
    // Before the closing brace, after the matchers: the grammar requires at
    // least one and admits no trailing comma, so a separator always goes first.
    const close = selector.node.to - 1;
    if (expr[close] !== "}") {
      throw new Error("LogQL row filter: a selector without a closing brace");
    }
    splices.push({ from: close, to: close, insert: `, ${binding.label}=${literal}` });
  }

  const out = applySplices(expr, splices);
  const rewritten = reparse(out);
  if (
    !sameSignature(
      withoutFilter(expr, root, binding.label),
      withoutFilter(out, rewritten, binding.label),
    )
  ) {
    throw new Error("LogQL row filter changed the expression's structure");
  }
  const after = selectorsOf(out, rewritten);
  if (after.length !== selectors.length) {
    throw new Error("LogQL row filter changed the number of selectors");
  }
  for (const selector of after) {
    const own = selector.matchers.filter((m) => m.label === binding.label);
    if (own.length !== 1 || own[0].op !== "=" || text(out, own[0].value) !== literal) {
      throw new Error("LogQL row filter left a selector unfiltered");
    }
  }
  return out;
}
