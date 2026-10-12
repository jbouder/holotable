import { parser } from "@grafana/lezer-logql";
import type { PromqlNode } from "@/lib/promql/parse";

/**
 * The LogQL parse tree (#561), from the Loki project's own grammar
 * (`@grafana/lezer-logql`, the one Grafana's Loki editor uses, pinned
 * exactly). Everything the guard decides, it decides on this tree, never on
 * the text: invariant 7 for a third language.
 *
 * The lezer tree is copied into plain objects once, in the same shape the
 * PromQL guard walks, so the language-neutral helpers (`nodes`, `child`,
 * `text`, the string literals and the splices) are shared rather than
 * written twice.
 */

/** The grammar's node name (`Selector`, `LineFilter`, `Rate`, …), its offsets and children. */
export type LogqlNode = PromqlNode;

export type ParseOutcome =
  | { ok: true; root: LogqlNode }
  | { ok: false; error: string; at: number };

/** The name an error node gets here, whatever lezer calls it. */
export const ERROR = "⚠";

/**
 * Parse one expression. A tree with an error node anywhere is refused with
 * the position of the first one: lezer recovers from errors and still builds
 * a tree, which must never be mistaken for a valid expression.
 */
export function parseLogql(expr: string): ParseOutcome {
  const root = copy(parser.parse(expr).cursor());
  for (const { node } of walk(root)) {
    if (node.type === ERROR) {
      return {
        ok: false,
        error: `LogQL does not parse at character ${node.from + 1}`,
        at: node.from,
      };
    }
  }
  return { ok: true, root };
}

type Cursor = ReturnType<ReturnType<typeof parser.parse>["cursor"]>;

/** Iterative, so no nesting an 8,000-character expression can reach overflows the stack. */
function copy(cursor: Cursor): LogqlNode {
  const make = (): LogqlNode => ({
    type: cursor.type.isError ? ERROR : cursor.type.name,
    from: cursor.from,
    to: cursor.to,
    children: [],
  });
  const root = make();
  const path: LogqlNode[] = [root];
  for (;;) {
    if (cursor.firstChild()) {
      const node = make();
      path[path.length - 1].children.push(node);
      path.push(node);
      continue;
    }
    for (;;) {
      if (path.length === 1) return root;
      path.pop();
      if (cursor.nextSibling()) {
        const node = make();
        path[path.length - 1].children.push(node);
        path.push(node);
        break;
      }
      cursor.parent();
    }
  }
}

/**
 * The grammar's left-recursive lists: `{a="1", b="2"}` is a `Matchers` inside
 * a `Matchers`, and every pipeline stage nests the ones before it. A node of
 * one of these types inside its own type is the same list, one item longer,
 * so it adds no nesting and no shape: a long pipeline is not a deep one, and
 * a matcher spliced into a selector changes nothing but the matchers.
 */
const LISTS = new Set([
  "Matchers",
  "PipelineExpr",
  "LineFilters",
  "LabelsFormat",
  "KeepLabels",
  "DropLabels",
  "LabelExtractionExpressionList",
  "LogfmtParserFlags",
  "Labels",
  "GroupingLabelList",
  "UnwrapExpr",
]);

/** Whether a node only continues its parent's list. */
export function continuesList(node: LogqlNode, parent: LogqlNode | null): boolean {
  return parent !== null && parent.type === node.type && LISTS.has(node.type);
}

/**
 * Every node, depth first, with its parent and its nesting: the depth with
 * the lists flattened, which is what the guard bounds and what a rewrite's
 * signature records.
 */
export function* walk(
  root: LogqlNode,
): Generator<{ node: LogqlNode; parent: LogqlNode | null; nesting: number }> {
  const stack: { node: LogqlNode; parent: LogqlNode | null; nesting: number }[] = [
    { node: root, parent: null, nesting: 0 },
  ];
  while (stack.length > 0) {
    const item = stack.pop() as {
      node: LogqlNode;
      parent: LogqlNode | null;
      nesting: number;
    };
    yield item;
    for (let i = item.node.children.length - 1; i >= 0; i--) {
      const node = item.node.children[i];
      stack.push({
        node,
        parent: item.node,
        nesting: item.nesting + (continuesList(node, item.node) ? 0 : 1),
      });
    }
  }
}

const UNIT_MS: Record<string, number> = {
  y: 31_536_000_000,
  w: 604_800_000,
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  s: 1_000,
  ms: 1,
  us: 0.001,
  µs: 0.001,
  ns: 0.000_001,
};

/**
 * A LogQL duration in milliseconds, signed: `5m`, `1h30m`, `1.5h`, `-1h`,
 * `250ms`. The grammar's `Duration` token admits Go's units and fractions;
 * `null` for anything else, which the guard refuses rather than guess at.
 */
export function logqlDurationMs(raw: string): number | null {
  const negative = raw.startsWith("-");
  const body = negative ? raw.slice(1) : raw;
  const unit = /(\d+(?:\.\d+)?)(ms|us|µs|ns|y|w|d|h|m|s)/y;
  let total = 0;
  let at = 0;
  while (at < body.length) {
    unit.lastIndex = at;
    const match = unit.exec(body);
    if (!match) return null;
    total += Number(match[1]) * UNIT_MS[match[2]];
    at = unit.lastIndex;
  }
  if (at === 0) return null;
  return negative ? -total : total;
}
