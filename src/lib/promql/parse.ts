import { parser } from "@prometheus-io/lezer-promql";

/**
 * The PromQL parse tree (#384), from the Prometheus project's own grammar
 * (`@prometheus-io/lezer-promql`, the one its UI and `codemirror-promql` use,
 * pinned exactly). Everything the guard decides, it decides on this tree,
 * never on the text: the SQL guard's rule (invariant 7) for a second
 * language.
 *
 * The lezer tree is copied into plain objects once, so the guard, the
 * rewrites and their verification walk the same simple shape, with the byte
 * offsets the rewrites splice at.
 */

export interface PromqlNode {
  /** The grammar's node name: `VectorSelector`, `StringLiteral`, `Rate`, … */
  type: string;
  from: number;
  to: number;
  children: PromqlNode[];
}

export type ParseOutcome =
  | { ok: true; root: PromqlNode }
  | { ok: false; error: string; at: number };

/**
 * Parse one expression. A tree with an error node anywhere is refused with
 * the position of the first one: lezer recovers from errors and still builds
 * a tree, which must never be mistaken for a valid expression.
 */
export function parsePromql(expr: string): ParseOutcome {
  const tree = parser.parse(expr);
  const root = copy(tree.cursor());
  const error = firstError(root);
  if (error) {
    return {
      ok: false,
      error: `PromQL does not parse at character ${error.from + 1}`,
      at: error.from,
    };
  }
  return { ok: true, root };
}

type Cursor = ReturnType<ReturnType<typeof parser.parse>["cursor"]>;

/** Iterative, so no nesting an 8,000-character expression can reach overflows the stack. */
function copy(cursor: Cursor): PromqlNode {
  const make = (): PromqlNode => ({
    type: cursor.type.isError ? ERROR : cursor.type.name,
    from: cursor.from,
    to: cursor.to,
    children: [],
  });
  const root = make();
  const path: PromqlNode[] = [root];
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

/** The name an error node gets here, whatever lezer calls it. */
export const ERROR = "⚠";

function firstError(root: PromqlNode): PromqlNode | null {
  for (const { node } of nodes(root)) if (node.type === ERROR) return node;
  return null;
}

/** Every node, depth first, with its depth and its parent. */
export function* nodes(
  root: PromqlNode,
): Generator<{ node: PromqlNode; depth: number; parent: PromqlNode | null }> {
  const stack: { node: PromqlNode; depth: number; parent: PromqlNode | null }[] = [
    { node: root, depth: 0, parent: null },
  ];
  while (stack.length > 0) {
    const item = stack.pop() as {
      node: PromqlNode;
      depth: number;
      parent: PromqlNode | null;
    };
    yield item;
    for (let i = item.node.children.length - 1; i >= 0; i--) {
      stack.push({
        node: item.node.children[i],
        depth: item.depth + 1,
        parent: item.node,
      });
    }
  }
}

export function child(node: PromqlNode, type: string): PromqlNode | undefined {
  return node.children.find((c) => c.type === type);
}

export function text(expr: string, node: PromqlNode): string {
  return expr.slice(node.from, node.to);
}

/**
 * A string literal's value, when it has no escape sequence; `null` when it
 * has one. PromQL decodes `"…"` and `'…'` with Go's escape rules and takes
 * `` `…` `` raw. Everything the guard compares against a name (a metric, a
 * label, a `:variable`) must be plain: a literal that needs decoding is never
 * read as one, so no spelling of a name can reach a comparison the guard did
 * not make.
 */
export function plainString(raw: string): string | null {
  if (raw.length < 2) return null;
  const quote = raw[0];
  if (raw[raw.length - 1] !== quote) return null;
  const body = raw.slice(1, -1);
  if (quote === "`") return body;
  if (quote !== '"' && quote !== "'") return null;
  return body.includes("\\") ? null : body;
}

/**
 * Whether a string literal is closed: the same quote at both ends, and the
 * closing one not escaped. The grammar's tokenizer accepts an unterminated
 * string without an error node, which the endpoint would then refuse, or
 * read differently; the guard refuses it first.
 */
export function isTerminatedString(raw: string): boolean {
  if (raw.length < 2) return false;
  const quote = raw[0];
  if (quote !== '"' && quote !== "'" && quote !== "`") return false;
  if (raw[raw.length - 1] !== quote) return false;
  if (quote === "`") return !raw.slice(1, -1).includes("`");
  // Walk the escapes: the closing quote must be the first unescaped one.
  for (let i = 1; i < raw.length - 1; i++) {
    if (raw[i] === "\\") i++;
    else if (raw[i] === quote) return false;
    else if (raw[i] === "\n") return false;
  }
  // An escape that swallowed the closing quote leaves nothing to close with.
  let backslashes = 0;
  for (let i = raw.length - 2; i > 0 && raw[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 0;
}

/**
 * A value as a PromQL string literal: double-quoted, with the backslash, the
 * quote and every control character escaped. The only way anything a viewer
 * picked, or a claim, is written into an expression.
 */
export function stringLiteral(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f)
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

/** A value with every RE2 metacharacter escaped, so it matches only itself. */
export function regexLiteral(value: string): string {
  return value.replace(/[\\.+*?()|[\]{}^$]/g, "\\$&");
}

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  y: 31_536_000_000,
};

/**
 * A PromQL duration in milliseconds: `5m`, `1h30m`, `500ms`, or a plain
 * number of seconds. `null` for anything else, which the guard refuses rather
 * than guess at.
 */
export function durationMs(raw: string): number | null {
  if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw) * 1_000;
  if (!/^(\d+(ms|s|m|h|d|w|y))+$/.test(raw)) return null;
  let total = 0;
  for (const [, n, unit] of raw.matchAll(/(\d+)(ms|s|m|h|d|w|y)/g)) {
    total += Number(n) * UNIT_MS[unit];
  }
  return total;
}
