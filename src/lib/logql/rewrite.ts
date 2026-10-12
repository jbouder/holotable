import { continuesList, type LogqlNode, parseLogql, walk } from "@/lib/logql/parse";
import { text } from "@/lib/promql/parse";

export { applySplices, type Splice, sameSignature } from "@/lib/promql/rewrite";

/**
 * What the LogQL rewrites share (#561), as `promql/rewrite.ts` does for
 * PromQL: the splices are the same, applied at the parser's offsets, and
 * each rewrite is proven by re-parsing its result and comparing the trees.
 *
 * The comparison flattens the grammar's left-recursive lists, so adding a
 * matcher to `{app="api"}` is one more item in the same list rather than a
 * new level, and the only difference left to explain is the item itself.
 */

/**
 * A tree as a list of `nesting:type` entries, with each leaf's text. Two
 * trees with equal signatures have the same shape and the same tokens.
 *
 * `skip` drops a node and everything under it, and `leaf` may say what a
 * leaf's text is expected to be, for the rewrites to describe their change.
 */
export function signature(
  expr: string,
  root: LogqlNode,
  opts: {
    skip?: (node: LogqlNode, parent: LogqlNode | null) => boolean;
    leaf?: (node: LogqlNode) => string | undefined;
  } = {},
): string[] {
  const out: string[] = [];
  const skipped = new Set<LogqlNode>();
  for (const { node, parent, nesting } of walk(root)) {
    if (parent && skipped.has(parent)) {
      skipped.add(node);
      continue;
    }
    if (opts.skip?.(node, parent)) {
      skipped.add(node);
      continue;
    }
    if (continuesList(node, parent)) continue;
    const leaf =
      node.children.length === 0 ? `=${opts.leaf?.(node) ?? text(expr, node)}` : "";
    out.push(`${nesting}:${node.type}${leaf}`);
  }
  return out;
}

/** Parse a rewrite's result, which must parse: it was built from a tree that did. */
export function reparse(expr: string): LogqlNode {
  const parsed = parseLogql(expr);
  if (!parsed.ok) {
    throw new Error("LogQL rewrite produced an expression that does not parse");
  }
  return parsed.root;
}
