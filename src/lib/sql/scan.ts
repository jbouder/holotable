/**
 * A lexical scan of a SQL statement, for the editor only.
 *
 * The guard parses with the real PostgreSQL grammar (`src/lib/sql/ast.ts`,
 * behind `libpg-query`), which is a WebAssembly build that loads its binary
 * from disk next to its own entrypoint and has no business in a browser
 * bundle. The editor still needs to know which stretches of the text are code
 * and which are string literals, quoted identifiers or comments — without
 * that, a hint that flags `--` would fire inside `'a--b'`, and a hint layer
 * that cries wolf on a statement the server accepts is worse than no hint
 * layer at all.
 *
 * So: a scanner, not a parser. It knows PostgreSQL's quoting rules exactly —
 * doubled quotes, `E''` backslash escapes, dollar quoting with tags, nested
 * block comments — and nothing else. Everything built on it treats its output
 * as a guess and defers to `validateSql` for the verdict.
 */

export type SpanKind =
  /** Anything the lexer would hand to the grammar: keywords, operators, numbers. */
  | "code"
  /** A string literal, in any of PostgreSQL's spellings. */
  | "string"
  /** A double-quoted identifier. */
  | "ident"
  /** A `--` line comment or a block comment. */
  | "comment";

export interface Span {
  kind: SpanKind;
  /** Offset of the first character, inclusive. */
  from: number;
  /** Offset one past the last character. */
  to: number;
}

/**
 * Split a statement into spans. The spans tile the whole input in order, so
 * `spans.map((s) => sql.slice(s.from, s.to)).join("")` reproduces it exactly.
 */
export function scan(sql: string): Span[] {
  const spans: Span[] = [];
  let codeFrom = 0;
  let i = 0;

  const closeCode = (at: number) => {
    if (at > codeFrom) spans.push({ kind: "code", from: codeFrom, to: at });
  };
  const push = (kind: SpanKind, from: number, to: number) => {
    closeCode(from);
    spans.push({ kind, from, to });
    codeFrom = to;
    i = to;
  };

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      push("comment", i, end === -1 ? sql.length : end);
      continue;
    }
    if (ch === "/" && next === "*") {
      push("comment", i, endOfBlockComment(sql, i));
      continue;
    }
    if (ch === '"') {
      push("ident", i, endOfDoubled(sql, i, '"'));
      continue;
    }
    if (ch === "'") {
      // A bare `'…'` only ends on an unpaired quote; `E'…'` also honours
      // backslash escapes, and its `E` sits in the preceding code span.
      push("string", i, endOfSingleQuoted(sql, i, hasEscapePrefix(sql, i)));
      continue;
    }
    if (ch === "$") {
      const end = endOfDollarQuoted(sql, i);
      if (end !== null) {
        push("string", i, end);
        continue;
      }
    }
    i++;
  }
  closeCode(sql.length);
  return spans;
}

export type TokenKind = "word" | "quoted" | "string" | "number" | "punct";

export interface Token {
  kind: TokenKind;
  /** The text exactly as written, quotes and all. */
  text: string;
  /**
   * The token's meaning to the grammar: a `word` folded to lower case, the way
   * PostgreSQL folds an unquoted identifier; a `quoted` identifier with its
   * quotes removed and its doubled quotes collapsed, case preserved, the way
   * PostgreSQL leaves a quoted one; a `string`'s contents. Comparing catalog
   * names against `value` is therefore the same comparison the server makes.
   */
  value: string;
  /**
   * True when the token is written with unicode escapes (`U&"\0068i"`), whose
   * decoding is the lexer's job and not this scanner's. `value` is then the
   * text as typed, which is *not* the name PostgreSQL will resolve, so anything
   * comparing names has to leave an escaped token alone.
   */
  escaped?: true;
  from: number;
  to: number;
}

const CODE_TOKEN =
  /[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|::|[^\s]/g;

/**
 * The statement as tokens, with comments dropped and every quoted form already
 * resolved to its value. Whitespace is not a token; offsets are preserved so a
 * hint can point at the text that provoked it.
 */
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  for (const span of scan(sql)) {
    const raw = sql.slice(span.from, span.to);
    if (span.kind === "comment") continue;
    if (span.kind === "ident" || span.kind === "string") {
      // `U&"…"` and `U&'…'` are one token to the lexer, spelled with a `U`, an
      // `&` and a quoted body. Take back the two tokens already emitted for the
      // prefix so the caller sees the single token PostgreSQL sees.
      const prefix = unicodePrefix(tokens, span.from);
      if (prefix !== null) tokens.length -= 2;
      const from = prefix ?? span.from;
      tokens.push({
        kind: span.kind === "ident" ? "quoted" : "string",
        text: sql.slice(from, span.to),
        value: span.kind === "ident" ? identValue(raw) : stringValue(raw),
        ...(prefix !== null ? { escaped: true as const } : {}),
        from,
        to: span.to,
      });
      continue;
    }
    CODE_TOKEN.lastIndex = 0;
    let match: RegExpExecArray | null = CODE_TOKEN.exec(raw);
    while (match !== null) {
      const text = match[0];
      const kind: TokenKind = /^[A-Za-z_\u0080-\uffff]/.test(text)
        ? "word"
        : /^\d/.test(text)
          ? "number"
          : "punct";
      tokens.push({
        kind,
        text,
        value: kind === "word" ? text.toLowerCase() : text,
        from: span.from + match.index,
        to: span.from + match.index + text.length,
      });
      match = CODE_TOKEN.exec(raw);
    }
  }
  return tokens;
}

/**
 * Where a `U&` unicode-escape prefix starts, when the last two tokens are one
 * sitting immediately before `at`.
 */
function unicodePrefix(tokens: Token[], at: number): number | null {
  const amp = tokens[tokens.length - 1];
  const u = tokens[tokens.length - 2];
  if (amp?.kind !== "punct" || amp.value !== "&" || amp.to !== at) return null;
  if (u?.kind !== "word" || u.value !== "u" || u.to !== amp.from) return null;
  return u.from;
}

/** The name a double-quoted identifier stands for, case preserved. */
function identValue(raw: string): string {
  const closed = raw.length > 1 && raw.endsWith('"');
  return raw.slice(1, closed ? -1 : undefined).replace(/""/g, '"');
}

/** The contents of a string literal, with the quoting undone. */
function stringValue(raw: string): string {
  const dollar = DOLLAR_TAG.exec(raw);
  if (dollar) return raw.slice(dollar[0].length, raw.length - dollar[0].length);
  const open = raw.indexOf("'");
  const body = raw.slice(open + 1, raw.endsWith("'") ? -1 : undefined);
  return body.replace(/''/g, "'");
}

function endOfBlockComment(sql: string, start: number): number {
  // PostgreSQL nests block comments, so `/* /* x */ */` is one comment.
  let depth = 0;
  let i = start;
  while (i < sql.length) {
    if (sql[i] === "/" && sql[i + 1] === "*") {
      depth++;
      i += 2;
      continue;
    }
    if (sql[i] === "*" && sql[i + 1] === "/") {
      depth--;
      i += 2;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  return sql.length;
}

/** `"ab""cd"` — the quote character doubles to escape itself. */
function endOfDoubled(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return sql.length;
}

function endOfSingleQuoted(sql: string, start: number, escapes: boolean): number {
  if (!escapes) return endOfDoubled(sql, start, "'");
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === "\\") {
      i += 2;
      continue;
    }
    if (sql[i] === "'") {
      if (sql[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return sql.length;
}

/** Whether the quote at `at` opens an `E'…'` escape-syntax literal. */
function hasEscapePrefix(sql: string, at: number): boolean {
  const prev = sql[at - 1];
  if (prev !== "e" && prev !== "E") return false;
  // Only when the `E` stands alone, not when it ends an identifier.
  const before = sql[at - 2];
  return before === undefined || !/[A-Za-z0-9_$]/.test(before);
}

const DOLLAR_TAG = /^\$([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/;

/**
 * `$$body$$` or `$tag$body$tag$`. Returns `null` when the `$` does not open a
 * dollar quote — a positional parameter, or an operator character — in which
 * case the caller leaves it in the code span. (The guard rejects `$1`
 * parameters outright; that is its call to make, not this scanner's.)
 */
function endOfDollarQuoted(sql: string, start: number): number | null {
  const open = DOLLAR_TAG.exec(sql.slice(start));
  if (!open) return null;
  const tag = open[0];
  const close = sql.indexOf(tag, start + tag.length);
  return close === -1 ? sql.length : close + tag.length;
}
