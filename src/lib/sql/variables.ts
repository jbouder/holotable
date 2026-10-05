import { scan, scanSync } from "libpg-query";

/**
 * Dashboard variables in panel SQL (#67): `:host` names a variable the
 * dashboard declares, and its value is only ever a bound parameter.
 *
 * The obvious implementation, splicing the selected value into the statement
 * text, would let a string a browser sent become SQL. So a reference is found
 * by PostgreSQL's own scanner (the same `libpg-query` build the guard parses
 * with), never by a regex over the text: `':host'` is a string literal,
 * `x::host` is a cast, `"…:host…"` is an identifier, and a comment is a
 * comment, exactly as the server will read them. Each reference is replaced,
 * at the scanner's byte offsets, by a `$n` placeholder, and the value goes in
 * the parameter list. Nothing a viewer selects is ever written into the text.
 *
 * A reference is a `:` token immediately followed, with nothing between them,
 * by a name token. `: host` is not one, and neither is `:"Host"`; both are
 * left for the parser, which refuses them. A slice written `a[1:n]` reads as
 * a reference to `n`, and is refused unless `n` is declared; `a[1 : n]` is a
 * slice.
 */

/**
 * What a reference's name token may look like before it is checked against
 * the declared names, which the IR holds to `VariableName`.
 */
const NAME_TOKEN_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface VariableRef {
  name: string;
  /** Byte offset of the `:`. */
  start: number;
  /** Byte offset one past the name. */
  end: number;
}

export interface VariableScan {
  refs: VariableRef[];
  /** The statement spells a `$n` of its own, which only the server may. */
  hasParam: boolean;
}

interface ScanToken {
  start: number;
  end: number;
  tokenName: string;
}

function fromTokens(sql: string, tokens: readonly ScanToken[]): VariableScan {
  const bytes = Buffer.from(sql, "utf8");
  const text = (t: ScanToken) => bytes.subarray(t.start, t.end).toString("utf8");
  const refs: VariableRef[] = [];
  let hasParam = false;
  tokens.forEach((t, i) => {
    if (t.tokenName === "PARAM") hasParam = true;
    if (text(t) !== ":") return;
    const next = tokens[i + 1];
    if (!next || next.start !== t.end) return;
    const name = text(next);
    if (NAME_TOKEN_RE.test(name)) refs.push({ name, start: t.start, end: next.end });
  });
  return { refs, hasParam };
}

/**
 * The variable references in a statement. Throws when the scanner cannot
 * tokenize it; the caller refuses the statement.
 */
export async function scanVariables(sql: string): Promise<VariableScan> {
  return fromTokens(sql, (await scan(sql)).tokens);
}

/** {@link scanVariables}, for `buildExecutablePlan`, which runs after the guard. */
export function scanVariablesSync(sql: string): VariableScan {
  return fromTokens(sql, scanSync(sql).tokens);
}

/** The distinct names, in order of first reference. */
export function referencedNames(refs: readonly VariableRef[]): string[] {
  return [...new Set(refs.map((r) => r.name))];
}

/**
 * Replace every reference with its placeholder, `$<number(name)>`. Spliced
 * right to left at byte offsets, so each splice leaves the earlier ones where
 * they were; the same name is the same placeholder wherever it appears.
 */
export function substituteVariables(
  sql: string,
  refs: readonly VariableRef[],
  number: (name: string) => number,
): string {
  let out = Buffer.from(sql, "utf8");
  for (const ref of [...refs].sort((a, b) => b.start - a.start)) {
    out = Buffer.concat([
      out.subarray(0, ref.start),
      Buffer.from(`$${number(ref.name)}`, "utf8"),
      out.subarray(ref.end),
    ]);
  }
  return out.toString("utf8");
}

/** A selected value: one string, or several for a multi-value variable. */
export type VariableValue = string | readonly string[];

/** The values a statement runs with, by variable name. */
export type VariableValues = Readonly<Record<string, VariableValue>>;

export class VariableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VariableError";
  }
}
