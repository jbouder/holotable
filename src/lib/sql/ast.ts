import {
  type A_Const,
  type ColumnRef,
  type CommonTableExpr,
  type FuncCall,
  type JoinExpr,
  type Node,
  type ParseResult,
  parse,
  parseSync,
  type RangeVar,
  type SQLValueFunction,
  scan,
  type SelectStmt,
  type WithClause,
} from "libpg-query";

/**
 * PostgreSQL parse-tree analysis for the SQL guard.
 *
 * `analyzeSelect()` runs untrusted SQL through the real PostgreSQL grammar
 * (libpg_query, compiled to WebAssembly) and walks the resulting tree. It
 * decides what the statement *is* — exactly one SELECT, built only from the
 * constructs allowlisted below — and reports every relation, function, value
 * keyword and string constant the statement contains. What is *dangerous* is
 * policy, and that stays in `safety.ts`; this module has no opinion about
 * `pg_sleep` or the catalog allowlist.
 *
 * Why a parser: string matching cannot tell `FROM` inside `extract(epoch FROM
 * ts)` from a table reference, a CTE alias from a real table, or `'insert'`
 * from `INSERT`. It also cannot see through dollar-quoting or unicode-escaped
 * identifiers. The parser tokenizes exactly the way the server will, so the
 * relation names reported here are the ones the server will resolve.
 *
 * Why an allowlist of node types: a denylist can only block what it has been
 * told about. Any construct that is not on the list — a statement type, a
 * clause, or a node added by a newer PostgreSQL — is rejected by name, so the
 * failure mode of an omission is an over-rejection, never a bypass.
 *
 * Scoping: a `RangeVar` is reported as a table unless it is an unqualified name
 * that a `WITH` clause in scope defines. Scope follows PostgreSQL's rules: a
 * non-recursive CTE sees only the CTEs written before it; `WITH RECURSIVE`
 * makes every name in the clause visible to every body; and a name defined
 * inside a subquery is not visible outside it. Getting this wrong in the
 * lenient direction is a bypass — `WITH a AS (SELECT * FROM b), b AS (SELECT
 * 1)` reads the real table `b` — so the rules are exact, not approximate.
 *
 * Columns: every `ColumnRef` is reported with its name parts, and every alias
 * that could rename or re-expose a table's columns — a table alias, a join
 * alias, a column alias list, `USING`, `NATURAL` — is reported beside it, so
 * the guard can enforce the per-column catalog. An unqualified `*` carries the
 * tables its own SELECT reads directly, which is exactly what it expands to;
 * a `*` over a subquery or a CTE expands only what that body already selected,
 * and that body is walked and checked on its own.
 */

/** The tag of any node the parser can emit, e.g. `"SelectStmt"`. */
export type NodeTag = Node extends infer U ? (U extends object ? keyof U : never) : never;

/**
 * Every node type a read-only SELECT may be built from. Anything else is
 * rejected as unsupported. Statement types other than `SelectStmt`, `ParamRef`,
 * `SQLValueFunction` and `LockingClause` are deliberately absent and get their
 * own error messages in `visitNode`.
 */
const ALLOWED_NODES: ReadonlySet<NodeTag> = new Set<NodeTag>([
  // The statement and its clauses.
  "SelectStmt",
  "ResTarget",
  "ColumnRef",
  "A_Star",
  "Alias",
  "SortBy",
  "WindowDef",
  "GroupingSet",
  "GroupingFunc",
  "CommonTableExpr",
  "List",

  // Things a FROM clause may contain.
  "RangeVar",
  "RangeSubselect",
  "RangeFunction",
  "JoinExpr",
  "RangeTableSample",
  "RangeTableFunc",
  "RangeTableFuncCol",

  // Constants.
  "A_Const",
  "String",
  "Integer",
  "Float",
  "Boolean",
  "BitString",

  // Expressions.
  "A_Expr",
  "BoolExpr",
  "NullTest",
  "BooleanTest",
  "CaseExpr",
  "CaseWhen",
  "CoalesceExpr",
  "MinMaxExpr",
  "RowExpr",
  "A_ArrayExpr",
  "A_Indirection",
  "A_Indices",
  "TypeCast",
  "TypeName",
  "CollateClause",
  "SubLink",
  "FuncCall",
  "NamedArgExpr",
  "XmlExpr",
  "XmlSerialize",

  // SQL/JSON (PostgreSQL 16+).
  "JsonObjectConstructor",
  "JsonArrayConstructor",
  "JsonArrayQueryConstructor",
  "JsonKeyValue",
  "JsonValueExpr",
  "JsonOutput",
  "JsonReturning",
  "JsonFormat",
  "JsonArgument",
  "JsonBehavior",
  "JsonFuncExpr",
  "JsonTablePathSpec",
  "JsonTable",
  "JsonTableColumn",
  "JsonParseExpr",
  "JsonScalarExpr",
  "JsonSerializeExpr",
  "JsonAggConstructor",
  "JsonObjectAgg",
  "JsonArrayAgg",
  "JsonIsPredicate",
]);

/** A relation the statement reads, as the server will resolve it. */
export interface TableRef {
  /** Present when the reference was schema-qualified. */
  schema?: string;
  name: string;
}

/** A function the statement calls, in any position (select list, FROM, WHERE …). */
export interface FunctionRef {
  /** The name as written, lowercased, e.g. `["pg_catalog", "pg_sleep"]`. */
  path: string[];
  /** The unqualified name, lowercased. */
  name: string;
}

/** A column reference — `email`, `u.email`, `u.*`, `*`, or a bare relation name. */
export interface ColumnUse {
  /** The name parts as the server will resolve them, without a trailing `*`. */
  path: string[];
  /** True for `*` and `x.*`. */
  star: boolean;
  /**
   * For an unqualified `*`, the tables its SELECT reads directly — through
   * joins and `TABLESAMPLE`, but not into a subquery or a CTE. Empty otherwise.
   */
  from: TableRef[];
}

/** A relation a FROM clause reads, with the name the statement gives it. */
export interface RelationUse {
  table: TableRef;
  /** `users AS u` → `u`. */
  alias?: string;
  /** `users AS u(a, b)`: the alias renames the table's columns by position. */
  renamesColumns: boolean;
  /** Byte offset of the relation name in the statement (UTF-8, as the parser counts). */
  location: number;
}

/** A join, and the ways it can match on or rename the columns beneath it. */
export interface JoinUse {
  /** The tables either side reads directly, as for {@link ColumnUse.from}. */
  tables: TableRef[];
  /** `NATURAL JOIN` matches on every column name the two sides share. */
  natural: boolean;
  /** The `USING (…)` column names. */
  using: string[];
  /** `(… JOIN …) AS j` and `USING (…) AS j`. */
  aliases: string[];
  /** `(… JOIN …) AS j(a, b)` renames the join's columns by position. */
  renamesColumns: boolean;
}

export interface SelectAnalysis {
  tables: TableRef[];
  /** Every column reference, in any position. */
  columns: ColumnUse[];
  /** Every read of a real table — a CTE name in scope is not one. */
  relations: RelationUse[];
  joins: JoinUse[];
  functions: FunctionRef[];
  /**
   * Parenless SQL value keywords — `current_timestamp`, `current_user`,
   * `session_user` and the rest of that family — which the grammar represents
   * as `SQLValueFunction` rather than as a function call.
   */
  keywords: string[];
  /** Every string constant in the statement. */
  strings: string[];
}

export type AnalyzeResult =
  | { ok: true; analysis: SelectAnalysis }
  | { ok: false; error: string };

type Scope = ReadonlySet<string>;

/** What a node can see: the CTE names in scope, and its SELECT's own tables. */
interface Context {
  ctes: Scope;
  from: TableRef[];
  /**
   * Accept `$n`. Only ever set when re-reading SQL the server itself wrote
   * (the row-filter rewrite, #31); untrusted SQL never carries a parameter.
   */
  params?: boolean;
}

class Rejected extends Error {}

function reject(message: string): never {
  throw new Rejected(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The parser wraps every node as `{ Tag: { …fields } }` with exactly one,
 * capitalised key. Plain structs — the fields of a `SelectStmt`, a
 * `WithClause`, an `Alias` — have lowercase keys and are not nodes.
 */
function asWrappedNode(value: unknown): [NodeTag, Record<string, unknown>] | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1) return null;
  const tag = keys[0];
  const inner = value[tag];
  if (!/^[A-Z]/.test(tag) || !isRecord(inner)) return null;
  return [tag as NodeTag, inner];
}

function walk(value: unknown, ctx: Context, out: SelectAnalysis): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, ctx, out);
    return;
  }
  if (!isRecord(value)) return;

  const wrapped = asWrappedNode(value);
  if (wrapped) {
    visitNode(wrapped[0], wrapped[1], ctx, out);
    return;
  }

  // A plain struct. The arms of a set operation (`larg`/`rarg`) are the one
  // place the grammar emits a SelectStmt without its wrapper; they normally
  // reach visitSelect directly, and this is the safety net for any other path.
  if (typeof value.op === "string" && value.op.startsWith("SETOP_")) {
    visitSelect(value as SelectStmt, ctx, out);
    return;
  }
  for (const [key, field] of Object.entries(value)) {
    if (key === "intoClause") reject("disallowed keyword: into");
    walk(field, ctx, out);
  }
}

function visitNode(
  tag: NodeTag,
  node: Record<string, unknown>,
  ctx: Context,
  out: SelectAnalysis,
): void {
  switch (tag) {
    case "SelectStmt":
      visitSelect(node as SelectStmt, ctx, out);
      return;
    case "RangeVar":
      visitRangeVar(node as RangeVar, ctx, out);
      return;
    case "ColumnRef":
      visitColumnRef(node as ColumnRef, ctx, out);
      return;
    case "JoinExpr":
      visitJoin(node as JoinExpr, ctx, out);
      break;
    case "FuncCall":
      visitFuncCall(node as FuncCall, out);
      break;
    case "A_Const":
      visitConst(node as A_Const, out);
      return;
    case "SQLValueFunction":
      out.keywords.push(sqlValueKeyword(node as SQLValueFunction));
      return;
    case "ParamRef":
      if (ctx.params) return;
      reject("query parameters are reserved by the server");
      break;
    case "LockingClause":
      reject("row locking (FOR UPDATE / FOR SHARE) is not allowed");
      break;
    default:
      if (tag.endsWith("Stmt")) reject("only SELECT/WITH queries are allowed");
      if (!ALLOWED_NODES.has(tag)) reject(`unsupported SQL construct: ${tag}`);
  }
  walk(node, ctx, out);
}

function visitSelect(stmt: SelectStmt, ctx: Context, out: SelectAnalysis): void {
  // `SELECT … INTO table` creates a table; it is the one write a SelectStmt
  // can express, and it lives in a plain field rather than a node.
  if (stmt.intoClause) reject("disallowed keyword: into");

  const ctes = stmt.withClause ? visitWith(stmt.withClause, ctx, out) : ctx.ctes;
  const inner: Context = {
    ctes,
    from: directTables(stmt.fromClause, ctes),
    params: ctx.params,
  };

  for (const [key, field] of Object.entries(stmt)) {
    if (key === "withClause" || key === "larg" || key === "rarg") continue;
    walk(field, inner, out);
  }
  if (stmt.larg) visitSelect(stmt.larg, inner, out);
  if (stmt.rarg) visitSelect(stmt.rarg, inner, out);
}

/**
 * The real tables a FROM list reads directly: through joins and
 * `TABLESAMPLE`, but not into a subquery, a function or a CTE, whose output
 * columns are whatever their own body selected.
 */
function directTables(items: unknown, ctes: Scope): TableRef[] {
  const out: TableRef[] = [];
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      for (const each of item) visit(each);
      return;
    }
    const wrapped = asWrappedNode(item);
    if (!wrapped) return;
    const [tag, node] = wrapped;
    if (tag === "RangeVar") {
      const ref = tableRef(node as RangeVar, ctes);
      if (ref) out.push(ref);
    } else if (tag === "JoinExpr") {
      visit(node.larg);
      visit(node.rarg);
    } else if (tag === "RangeTableSample") {
      visit(node.relation);
    }
  };
  visit(items);
  return out;
}

/** Walks every CTE body with the names PostgreSQL would let it see; returns the scope for the statement body. */
function visitWith(clause: WithClause, ctx: Context, out: SelectAnalysis): Scope {
  const scope = ctx.ctes;
  const ctes = clause.ctes ?? [];
  const names = ctes.map(cteName);
  const all: Scope = new Set([...scope, ...names]);

  ctes.forEach((cte, index) => {
    // Without RECURSIVE a CTE may reference only the CTEs written before it;
    // any other name — including its own — is a real table. With RECURSIVE
    // every name in the clause is visible to every body.
    const visible: Scope = clause.recursive
      ? all
      : new Set([...scope, ...names.slice(0, index)]);
    walk(cte, { ctes: visible, from: ctx.from, params: ctx.params }, out);
  });

  return all;
}

function cteName(node: Node): string {
  const wrapped = asWrappedNode(node);
  if (wrapped?.[0] !== "CommonTableExpr") {
    reject("unsupported SQL construct in WITH clause");
  }
  const name = (wrapped[1] as CommonTableExpr).ctename;
  if (!name) reject("unsupported SQL construct in WITH clause");
  return name;
}

function visitRangeVar(rv: RangeVar, ctx: Context, out: SelectAnalysis): void {
  const table = tableRef(rv, ctx.ctes);
  if (!table) return;
  out.tables.push(table);
  out.relations.push({
    table,
    alias: rv.alias?.aliasname,
    renamesColumns: (rv.alias?.colnames?.length ?? 0) > 0,
    location: rv.location ?? -1,
  });
}

/** The real table a RangeVar names, or null when it names a CTE in scope. */
function tableRef(rv: RangeVar, ctes: Scope): TableRef | null {
  const name = rv.relname;
  if (!name) reject("invalid table reference");
  if (rv.catalogname) {
    reject(
      `invalid table reference: ${[rv.catalogname, rv.schemaname, name]
        .filter(Boolean)
        .join(".")}`,
    );
  }
  // An unqualified name that a WITH clause in scope defines is that CTE, not a
  // table. A schema-qualified name is always a real relation.
  if (!rv.schemaname && ctes.has(name)) return null;
  return { schema: rv.schemaname, name };
}

function visitColumnRef(ref: ColumnRef, ctx: Context, out: SelectAnalysis): void {
  const path: string[] = [];
  let star = false;
  for (const field of ref.fields ?? []) {
    const wrapped = asWrappedNode(field);
    // The grammar only puts names and a final `*` here; anything else fails
    // closed rather than being skipped.
    if (star) reject("invalid column reference");
    if (wrapped?.[0] === "A_Star") {
      star = true;
    } else if (wrapped?.[0] === "String" && typeof wrapped[1].sval === "string") {
      path.push(wrapped[1].sval);
    } else {
      reject("invalid column reference");
    }
  }
  if (path.length === 0 && !star) reject("invalid column reference");
  out.columns.push({ path, star, from: star && path.length === 0 ? ctx.from : [] });
}

function visitJoin(join: JoinExpr, ctx: Context, out: SelectAnalysis): void {
  const names = (list: Node[] | undefined): string[] =>
    (list ?? []).map((item) => {
      const wrapped = asWrappedNode(item);
      const sval = wrapped?.[1].sval;
      if (wrapped?.[0] !== "String" || typeof sval !== "string") {
        reject("invalid join column");
      }
      return sval;
    });
  out.joins.push({
    tables: directTables([join.larg, join.rarg], ctx.ctes),
    natural: join.isNatural === true,
    using: names(join.usingClause),
    aliases: [join.alias?.aliasname, join.join_using_alias?.aliasname].filter(
      (alias): alias is string => typeof alias === "string",
    ),
    renamesColumns: (join.alias?.colnames?.length ?? 0) > 0,
  });
}

function visitFuncCall(fn: FuncCall, out: SelectAnalysis): void {
  const path = (fn.funcname ?? []).map((part) => {
    const wrapped = asWrappedNode(part);
    const sval = wrapped?.[1].sval;
    if (wrapped?.[0] !== "String" || typeof sval !== "string") {
      reject("invalid function reference");
    }
    return sval.toLowerCase();
  });
  if (path.length === 0) reject("invalid function reference");
  out.functions.push({ path, name: path[path.length - 1] });
}

function visitConst(node: A_Const, out: SelectAnalysis): void {
  const text = node.sval?.sval;
  if (typeof text === "string") out.strings.push(text);
}

/** `SVFOP_CURRENT_TIMESTAMP_N` → `current_timestamp`. */
function sqlValueKeyword(node: SQLValueFunction): string {
  return (node.op ?? "SVFOP_UNKNOWN")
    .replace(/^SVFOP_/, "")
    .replace(/_N$/, "")
    .toLowerCase();
}

/**
 * Parse one statement and analyze it as a read-only SELECT.
 *
 * Fails closed: anything the parser cannot parse, more or fewer than one
 * statement, a statement that is not a SELECT, or any construct outside the
 * allowlist is rejected with a reason.
 */
export async function analyzeSelect(sql: string): Promise<AnalyzeResult> {
  let parsed: ParseResult;
  try {
    parsed = await parse(sql);
  } catch (err) {
    return unparseable(err);
  }
  return analyzeParsed(parsed, false);
}

/**
 * {@link analyzeSelect}, synchronously, for the row-filter rewrite (#31),
 * which runs inside `buildExecutablePlan`. The parser must already be loaded,
 * which it always is by then: `validateSql` ran first. If it somehow is not,
 * this throws, and the plan is not built.
 *
 * `params` accepts `$n`, for re-reading the server's own rewritten SQL.
 */
export function analyzeSelectSync(
  sql: string,
  opts: { params?: boolean } = {},
): AnalyzeResult {
  let parsed: ParseResult;
  try {
    parsed = parseSync(sql);
  } catch (err) {
    return unparseable(err);
  }
  return analyzeParsed(parsed, opts.params ?? false);
}

function unparseable(err: unknown): AnalyzeResult {
  const detail = err instanceof Error && err.message ? `: ${err.message}` : "";
  return { ok: false, error: `only SELECT/WITH queries are allowed${detail}` };
}

function analyzeParsed(parsed: ParseResult, params: boolean): AnalyzeResult {
  const stmts = (parsed.stmts ?? []).flatMap((raw) => (raw.stmt ? [raw.stmt] : []));

  if (stmts.length === 0) return { ok: false, error: "empty SQL" };
  if (stmts.length > 1)
    return { ok: false, error: "multiple statements are not allowed" };

  const wrapped = asWrappedNode(stmts[0]);
  if (wrapped?.[0] !== "SelectStmt") {
    return { ok: false, error: "only SELECT/WITH queries are allowed" };
  }

  const analysis: SelectAnalysis = {
    tables: [],
    columns: [],
    relations: [],
    joins: [],
    functions: [],
    keywords: [],
    strings: [],
  };
  try {
    visitSelect(
      wrapped[1] as SelectStmt,
      { ctes: new Set(), from: [], params },
      analysis,
    );
  } catch (err) {
    if (err instanceof Rejected) return { ok: false, error: err.message };
    throw err;
  }
  return { ok: true, analysis };
}

/**
 * True when the statement contains a real `--` or block comment. The lexer
 * decides, so `'--'` inside a string literal is not a comment. A statement the
 * lexer cannot tokenize is reported as commented — it fails closed, and
 * `analyzeSelect` will already have rejected it with a better message.
 */
export async function containsComment(sql: string): Promise<boolean> {
  try {
    const { tokens } = await scan(sql);
    return tokens.some(
      (t) => t.tokenName === "SQL_COMMENT" || t.tokenName === "C_COMMENT",
    );
  } catch {
    return true;
  }
}
