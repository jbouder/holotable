import { nodes, type PromqlNode, parsePromql, text } from "@/lib/promql/parse";

/**
 * What the PromQL rewrites share (#384): splicing text in at the parser's
 * offsets, and proving afterwards that nothing but the splice changed.
 *
 * The HTTP API has no bound parameters, so a variable's value and a tenant's
 * claim value are written into the expression itself. Each rewrite is
 * therefore checked the way the SQL row filter is: the result is parsed
 * again, and its tree is compared, node by node, with the original's, with
 * only the expected differences allowed.
 */

export interface Splice {
  from: number;
  to: number;
  insert: string;
}

/** Apply non-overlapping splices to the text, right to left. */
export function applySplices(expr: string, splices: Splice[]): string {
  const ordered = [...splices].sort((a, b) => b.from - a.from);
  let out = expr;
  let limit = Number.POSITIVE_INFINITY;
  for (const s of ordered) {
    if (s.to > limit) throw new Error("PromQL rewrite: overlapping splices");
    out = out.slice(0, s.from) + s.insert + out.slice(s.to);
    limit = s.from;
  }
  return out;
}

/**
 * A tree as a list of `depth:type` entries, with each leaf's text. Two trees
 * with equal signatures have the same shape and the same tokens.
 *
 * `skip` drops a node and everything under it, and `leaf` may say what a
 * leaf's text is expected to be, for the rewrites to describe their change.
 */
export function signature(
  expr: string,
  root: PromqlNode,
  opts: {
    skip?: (node: PromqlNode) => boolean;
    leaf?: (node: PromqlNode) => string | undefined;
  } = {},
): string[] {
  const out: string[] = [];
  const skipped = new Set<PromqlNode>();
  for (const { node, depth, parent } of nodes(root)) {
    if (parent && skipped.has(parent)) {
      skipped.add(node);
      continue;
    }
    if (opts.skip?.(node)) {
      skipped.add(node);
      continue;
    }
    const leaf =
      node.children.length === 0 ? `=${opts.leaf?.(node) ?? text(expr, node)}` : "";
    out.push(`${depth}:${node.type}${leaf}`);
  }
  return out;
}

/** Parse a rewrite's result, which must parse: it was built from a tree that did. */
export function reparse(expr: string): PromqlNode {
  const parsed = parsePromql(expr);
  if (!parsed.ok)
    throw new Error(`PromQL rewrite produced an expression that does not parse`);
  return parsed.root;
}

export function sameSignature(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((entry, i) => entry === b[i]);
}
