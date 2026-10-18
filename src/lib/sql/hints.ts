import { allowedTables, type SourceCatalog } from "@/lib/registry";
import {
  FORBIDDEN_FUNCTION_SET,
  FORBIDDEN_TIME_FUNCTION_SET,
  TIME_INPUT_LITERALS,
} from "@/lib/sql/denylist";
import { scan, type Token, tokenize } from "@/lib/sql/scan";

/**
 * The editor's hint layer: the guard's most common refusals, shown while the
 * author types instead of after they press Validate.
 *
 * **This decides nothing.** `validateSql` on the server is the authority, and
 * it re-checks everything here with the real parser before a statement is ever
 * saved or run. What this file adds is speed of feedback, and it buys that
 * with a deliberate asymmetry:
 *
 *   - Every hint it emits names a rule the server *will* refuse on. A rule only
 *     goes in when a lexical scan can be certain — a comment is a comment, a
 *     `pg_sleep(` is a `pg_sleep(`, a table not in the allowlist is not in the
 *     allowlist. Anything the scanner cannot be certain about is left silent.
 *   - It is therefore incomplete in the other direction, and that is the
 *     correct trade. A statement with no hints is not a statement the server
 *     has accepted; it is one the browser could not convict. The guard sees
 *     through dollar-quoting, unicode escapes and adjacent-literal
 *     concatenation, and a lexer that tried to would be a second
 *     implementation of the thing that must not be re-implemented.
 *
 * A hint layer that over-reports is worse than none — an author who has been
 * told twice that a valid query is broken stops reading the third message — so
 * where the two directions conflict, silence wins. `test/sql-hints.test.ts`
 * pins this by running every entry in the fuzz corpus through both: nothing
 * the corpus marks acceptable may draw a hint, and nothing hinted here may be
 * something `validateSql` accepts.
 */

export interface SqlHint {
  /** Offset of the first character of the offending text. */
  from: number;
  /** Offset one past the last. */
  to: number;
  /** The guard's own wording, so the hint reads like the eventual rejection. */
  message: string;
}

/**
 * Statement verbs that are certainly not a SELECT. The guard accepts exactly
 * one `SelectStmt`, which in PostgreSQL's grammar also covers `VALUES` and
 * `TABLE t` — so a first word not on this list is *not* reported, even when it
 * looks wrong. Only a word that is definitely another kind of statement is.
 */
const NOT_A_SELECT = new Set([
  "insert",
  "update",
  "delete",
  "merge",
  "create",
  "alter",
  "drop",
  "truncate",
  "grant",
  "revoke",
  "copy",
  "call",
  "do",
  "set",
  "reset",
  "begin",
  "start",
  "commit",
  "rollback",
  "savepoint",
  "explain",
  "analyze",
  "vacuum",
  "refresh",
  "reindex",
  "comment",
  "show",
  "listen",
  "notify",
  "unlisten",
  "prepare",
  "execute",
  "deallocate",
  "declare",
  "fetch",
  "close",
  "move",
  "lock",
  "discard",
  "import",
  "security",
]);

/**
 * Parenless value keywords: each is either a clock reading or server identity,
 * and the guard rejects all of them. Only counted when the word is not an
 * attribute name — `t.current_date` is a perfectly ordinary column reference,
 * because PostgreSQL allows a reserved word after the dot.
 */
const VALUE_KEYWORDS = new Set([
  "current_timestamp",
  "current_date",
  "current_time",
  "localtime",
  "localtimestamp",
  "current_user",
  "session_user",
  "system_user",
  "current_role",
  "current_catalog",
  "current_schema",
]);

const TIME_ERROR_SUFFIX =
  "the server owns the time range, and a spec must produce the same query on every tick";

/** Keywords that end the FROM item a table name could have been. */
const AFTER_FROM_NOISE = new Set(["only", "lateral"]);

/**
 * Everything the browser can be sure the guard will refuse, in document order.
 */
export function sqlHints(sql: string, catalog: SourceCatalog | null): SqlHint[] {
  const hints: SqlHint[] = [];

  for (const span of scan(sql)) {
    if (span.kind === "comment") {
      hints.push({ from: span.from, to: span.to, message: "comments are not allowed" });
    }
  }

  const tokens = tokenize(sql);
  // The guard strips trailing terminators before parsing, so only a `;` with
  // something after it makes this more than one statement.
  const lastReal = tokens.reduce(
    (at, t, i) => (t.kind === "punct" && t.value === ";" ? at : i),
    -1,
  );
  for (const [i, token] of tokens.entries()) {
    if (token.kind === "punct" && token.value === ";" && i < lastReal) {
      hints.push({
        from: token.from,
        to: token.to,
        message: "multiple statements are not allowed",
      });
      break;
    }
  }

  const first = tokens.find((t) => t.kind === "word" || t.kind === "quoted");
  if (first?.kind === "word" && NOT_A_SELECT.has(first.value)) {
    hints.push({
      from: first.from,
      to: first.to,
      message: "only SELECT/WITH queries are allowed",
    });
  }

  for (const [i, token] of tokens.entries()) {
    if (token.kind === "string") {
      // An escaped literal's real contents are the lexer's to decode.
      if (token.escaped) continue;
      if (TIME_INPUT_LITERALS.has(token.value.trim().toLowerCase())) {
        hints.push({
          from: token.from,
          to: token.to,
          message: `disallowed time literal '${token.value}': ${TIME_ERROR_SUFFIX}`,
        });
      }
      continue;
    }
    if (token.kind !== "word") continue;

    const previous = tokens[i - 1];
    const next = tokens[i + 1];
    const qualified = previous?.kind === "punct" && previous.value === ".";
    const called = next?.kind === "punct" && next.value === "(";
    // `current_schema` is a value keyword the guard refuses; `current_schema()`
    // is an ordinary function call it does not. Only the parenless form.
    if (!qualified && !called && VALUE_KEYWORDS.has(token.value)) {
      hints.push({
        from: token.from,
        to: token.to,
        message: `disallowed keyword: ${token.value}`,
      });
      continue;
    }

    if (called) {
      if (FORBIDDEN_FUNCTION_SET.has(token.value)) {
        hints.push({
          from: token.from,
          to: token.to,
          message: `disallowed table function: ${token.value}()`,
        });
      } else if (FORBIDDEN_TIME_FUNCTION_SET.has(token.value)) {
        hints.push({
          from: token.from,
          to: token.to,
          message: `disallowed function ${token.value}(): ${TIME_ERROR_SUFFIX}`,
        });
      }
    }
  }

  if (catalog) hints.push(...catalogHints(tokens, catalog));
  return hints.sort((a, b) => a.from - b.from);
}

/**
 * Relations named after FROM or JOIN that the allowlist does not contain.
 *
 * Deliberately narrow. A name is reported only when it is a plain identifier
 * (optionally schema-qualified) that no `WITH` clause in the statement defines
 * and no `(` follows — a set-returning function, a subquery, a table alias in
 * a later clause and anything the scanner did not recognise all pass without
 * comment. The comparison is the server's: an unquoted name folded to lower
 * case, a quoted one exactly as written.
 */
function catalogHints(tokens: Token[], catalog: SourceCatalog): SqlHint[] {
  const allow = allowedTables(catalog);
  const cteNames = commonTableNames(tokens);
  const hints: SqlHint[] = [];

  // Which parentheses we are inside. `extract(epoch FROM ts)` and
  // `substring(x FROM 1)` put a FROM where no relation follows it, and reading
  // `ts` there as a table would be exactly the false alarm this layer must not
  // raise. A paren that opens a query is transparent; a call's is not.
  const parens: ("query" | "call")[] = [];

  for (const [i, token] of tokens.entries()) {
    if (token.kind === "punct" && token.value === "(") {
      const inner = tokens[i + 1];
      const opensQuery =
        inner?.kind === "word" &&
        (inner.value === "select" || inner.value === "with" || inner.value === "values");
      parens.push(opensQuery ? "query" : "call");
      continue;
    }
    if (token.kind === "punct" && token.value === ")") {
      parens.pop();
      continue;
    }
    if (token.kind !== "word") continue;
    if (token.value !== "from" && token.value !== "join") continue;
    if (parens[parens.length - 1] === "call") continue;

    let at = i + 1;
    while (tokens[at]?.kind === "word" && AFTER_FROM_NOISE.has(tokens[at].value)) at++;

    const name = tokens[at];
    if (!name || (name.kind !== "word" && name.kind !== "quoted")) continue;
    // `U&"\0068ttp_requests"` is `http_requests` to the lexer and something
    // else entirely to a scanner. Found by the fuzz suite.
    if (name.escaped) continue;
    // A keyword where a relation should be means the scanner has lost the
    // thread (`extract(epoch FROM ts)`, `FROM (SELECT …)`). Say nothing.
    if (name.kind === "word" && RELATION_STOP_WORDS.has(name.value)) continue;

    let to = at;
    let reference = name.value;
    if (tokens[at + 1]?.value === "." && tokens[at + 2]) {
      const qualified = tokens[at + 2];
      if (qualified.escaped) continue;
      if (qualified.kind === "word" || qualified.kind === "quoted") {
        reference = `${name.value}.${qualified.value}`;
        to = at + 2;
      }
    }
    // A function call, not a relation.
    if (tokens[to + 1]?.kind === "punct" && tokens[to + 1].value === "(") continue;
    if (!reference.includes(".") && cteNames.has(reference)) continue;
    if (allow.has(reference)) continue;

    hints.push({
      from: name.from,
      to: tokens[to].to,
      message: `table not in catalog allowlist: ${reference}`,
    });
  }
  return hints;
}

/**
 * Words that may follow FROM or JOIN without being a relation. Reserved words
 * cannot be a relation name unquoted, so skipping them costs nothing.
 */
const RELATION_STOP_WORDS = new Set([
  "select",
  "values",
  "table",
  "unnest",
  "rows",
  "with",
]);

/**
 * Every name a `WITH` clause introduces, whatever nesting it sits at.
 *
 * Scope is ignored on purpose: the guard resolves CTE visibility exactly (a
 * name used before it is defined reads the real table, which is a bypass it
 * has to catch), and a hint layer that tried to reproduce those rules would
 * eventually disagree with it. Treating every CTE name as defined can only
 * make this quieter, never louder — which is also why it does not matter that
 * the `name AS (…)` shape catches a `WINDOW w AS (…)` definition too.
 */
function commonTableNames(tokens: Token[]): Set<string> {
  const names = new Set<string>();
  for (const [i, token] of tokens.entries()) {
    if (token.kind !== "word" || token.value !== "as") continue;
    // `AS (`, `AS MATERIALIZED (`, `AS NOT MATERIALIZED (`.
    let body = i + 1;
    if (tokens[body]?.kind === "word" && tokens[body].value === "not") body++;
    if (tokens[body]?.kind === "word" && tokens[body].value === "materialized") body++;
    if (tokens[body]?.value !== "(") continue;
    // `name AS (…)`, or `name(col, …) AS (…)` — a CTE may declare its output
    // column names, which puts a parenthesized list between the two.
    let at = i - 1;
    if (tokens[at]?.kind === "punct" && tokens[at].value === ")") {
      at = openingParen(tokens, at) - 1;
    }
    const name = tokens[at];
    if (name && (name.kind === "word" || name.kind === "quoted")) names.add(name.value);
  }
  return names;
}

/** The index of the `(` that the `)` at `close` closes, or -1. */
function openingParen(tokens: Token[], close: number): number {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (tokens[i].kind !== "punct") continue;
    if (tokens[i].value === ")") depth++;
    else if (tokens[i].value === "(") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The columns the statement will hand back, when they can be read off the
 * SELECT list with certainty.
 *
 * This is what the `timeField` picker offers and warns against, and why it has
 * to be the *output* columns rather than the catalog's: the server filters
 * time on the wrapper's column (`_holo.<timeField>`), so a query that renames
 * `ts` to `bucket` must declare `bucket`. `complete` is false as soon as one
 * item cannot be resolved — a `*`, an expression with no alias, anything past
 * the end of what the scanner understands — and every warning is suppressed
 * while it is.
 */
export interface SelectOutputs {
  columns: string[];
  complete: boolean;
}

const SELECT_LIST_END = new Set([
  "from",
  "where",
  "group",
  "having",
  "window",
  "order",
  "limit",
  "offset",
  "fetch",
  "union",
  "intersect",
  "except",
]);

export function selectOutputs(sql: string): SelectOutputs {
  const tokens = tokenize(sql);
  let depth = 0;
  let start = -1;
  for (const [i, token] of tokens.entries()) {
    if (token.kind === "punct" && token.value === "(") depth++;
    else if (token.kind === "punct" && token.value === ")") depth--;
    else if (depth === 0 && token.kind === "word" && token.value === "select") {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return { columns: [], complete: false };

  // `SELECT DISTINCT ON (…) x` — the parenthesized list is not output.
  if (tokens[start]?.kind === "word" && tokens[start].value === "distinct") start++;
  if (tokens[start]?.kind === "word" && tokens[start].value === "all") start++;
  if (tokens[start]?.kind === "word" && tokens[start].value === "on") {
    return { columns: [], complete: false };
  }

  const items: Token[][] = [[]];
  depth = 0;
  let complete = false;
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "punct" && token.value === "(") depth++;
    if (token.kind === "punct" && token.value === ")") {
      // A `)` at depth 0 closes a parenthesized query this scan started inside.
      if (depth === 0) break;
      depth--;
    }
    if (depth === 0 && token.kind === "word" && SELECT_LIST_END.has(token.value)) {
      complete = true;
      break;
    }
    if (depth === 0 && token.kind === "punct" && token.value === ",") {
      items.push([]);
      continue;
    }
    items[items.length - 1].push(token);
  }

  const columns: string[] = [];
  for (const item of items) {
    const name = outputName(item);
    if (name === null) return { columns, complete: false };
    columns.push(name);
  }
  return { columns, complete: complete && columns.length > 0 };
}

/**
 * The name PostgreSQL would give one select-list item, or `null` when the
 * scanner cannot say. Covers the three shapes that appear in practice: an
 * explicit `AS alias`, a bare column reference (`ts`, `t.ts`), and a call whose
 * function name becomes the column name (`count(*)` → `count`). A cast is
 * transparent, as it is in the server's own `FigureColname`.
 */
function outputName(item: Token[]): string | null {
  // An explicit alias settles it, and it is read before casts are stripped:
  // the `::` in `ts::date AS bucket` is not what names the column.
  const explicit = item[item.length - 2];
  const alias = item[item.length - 1];
  if (explicit?.kind === "word" && explicit.value === "as") {
    return alias.kind === "word" || alias.kind === "quoted" ? alias.value : null;
  }

  const tokens = stripCast(item);
  if (tokens.length === 0) return null;
  const last = tokens[tokens.length - 1];

  if (tokens.length === 1 && (last.kind === "word" || last.kind === "quoted")) {
    return last.value;
  }
  if (isDottedReference(tokens)) return last.value;
  if (isSingleCall(tokens)) return tokens[0].value;
  // `expr alias` without AS is a real shape, but telling it from the tail of an
  // expression needs a grammar. Unknown, which makes the whole list unknown.
  return null;
}

/** `a.b`, `a.b.c`, `"A".b` — identifiers joined by dots and nothing else. */
function isDottedReference(tokens: Token[]): boolean {
  if (tokens.length % 2 === 0) return false;
  return tokens.every((token, i) =>
    i % 2 === 0
      ? token.kind === "word" || token.kind === "quoted"
      : token.kind === "punct" && token.value === ".",
  );
}

/** `f(…)` with the call spanning the whole item. */
function isSingleCall(tokens: Token[]): boolean {
  if (tokens.length < 3) return false;
  if (tokens[0].kind !== "word") return false;
  if (tokens[1].value !== "(") return false;
  if (tokens[tokens.length - 1].value !== ")") return false;
  let depth = 0;
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i].value === "(") depth++;
    if (tokens[i].value === ")") {
      depth--;
      if (depth === 0) return i === tokens.length - 1;
    }
  }
  return false;
}

/**
 * Drop a trailing `::type`, which does not change the column's name —
 * `count(*)::int` is still `count`, as PostgreSQL's own `FigureColname` has it.
 * Only at paren depth zero: the cast in `count(x::int)` belongs to the
 * argument, and cutting there would lose the call.
 */
function stripCast(tokens: Token[]): Token[] {
  let depth = 0;
  for (const [i, token] of tokens.entries()) {
    if (token.kind !== "punct") continue;
    if (token.value === "(") depth++;
    else if (token.value === ")") depth--;
    else if (token.value === "::" && depth === 0) return tokens.slice(0, i);
  }
  return tokens;
}

/**
 * The `timeField` values worth offering, best first.
 *
 * Output columns come first because they are what the server actually filters
 * on. Timestamp-typed catalog columns follow: with `SELECT *` they *are* the
 * output columns, and with anything else they are at least the right names to
 * alias to.
 */
export function timeFieldCandidates(
  sql: string,
  catalog: SourceCatalog | null,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push(name);
  };
  for (const column of selectOutputs(sql).columns) add(column);
  for (const table of catalog?.tables ?? []) {
    if (table.timeField) add(table.timeField);
    for (const column of table.columns) {
      if (isTimestampType(column.type)) add(column.name);
    }
  }
  return out;
}

/** `timestamp with time zone`, `timestamptz`, `date`, `timestamp(3)` … */
export function isTimestampType(type: string): boolean {
  return /^(timestamp|timestamptz|date)\b/i.test(type.trim());
}

/**
 * Why the declared `timeField` will not work, or `null` when nothing is
 * certainly wrong.
 *
 * Two failures are worth catching here, because both surface as an execution
 * error with no clue in it. A name that is not a plain identifier is refused
 * outright by `buildExecutablePlan`. A name that is not among the query's
 * output columns makes the server's `WHERE _holo.<timeField>` reference a
 * column that does not exist — the mistake `isMissingTimeFieldError` exists to
 * explain after the fact, said before the fact instead.
 */
export function timeFieldWarning(
  timeField: string | undefined,
  outputs: SelectOutputs,
): string | null {
  if (!timeField) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(timeField)) {
    return `"${timeField}" is not a plain column name, and the server will refuse to filter on it.`;
  }
  if (!outputs.complete || outputs.columns.includes(timeField)) return null;
  const listed = outputs.columns.join(", ");
  return `The query does not return a column called "${timeField}"${
    listed ? ` — it returns ${listed}` : ""
  }. The server filters time on the query's output, so this will fail when it runs.`;
}
