import { z } from "zod";
import type { SourceRecord } from "@/lib/registry";
import type { ListingBase } from "@/lib/source-listing";
import {
  CatalogTable,
  MAX_TABLES,
  RowFilter,
  type SourceCatalog,
  exposedTable,
} from "@/lib/sources/catalog";
import type { SourceKind } from "@/lib/sources/types";

/**
 * DuckDB (#572): a directory of Parquet, CSV and JSON files (#596), or a
 * `.duckdb` database file, under the operator's `DUCKDB_SOURCES_DIR`, queried in
 * process. Its panels carry SQL, checked by the same guard as TimescaleDB's.
 *
 * Everything here is what a source of this kind *is* and what may be shown of
 * it; how it is opened is the server half, `src/lib/sources/server/duckdb.ts`,
 * which the browser bundle never imports. A DuckDB source names no
 * `secret_ref`: there is nothing to log in to.
 */

/** The longest `path` a config may name. */
export const MAX_DUCKDB_PATH = 512;

/** The file extension that makes a path a database rather than a directory. */
export const DUCKDB_FILE_EXTENSION = ".duckdb";

/**
 * Why a source path cannot be stored, or null. Lexical only: the server half
 * resolves it against `DUCKDB_SOURCES_DIR`, symlinks included, before any
 * file is opened (`src/lib/duckdb/path.ts`). This is the first of the two
 * checks, so a path that could only mean "outside the root" is refused where
 * it is typed.
 */
export function duckdbPathProblem(path: string): string | null {
  if (path.length === 0) return "must name a directory or a .duckdb file";
  if (path.length > MAX_DUCKDB_PATH) {
    return `must be at most ${MAX_DUCKDB_PATH} characters`;
  }
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    return "must be relative to DUCKDB_SOURCES_DIR, not absolute";
  }
  if (path.includes("\\") || [...path].some((c) => c < " " || c === "\x7f")) {
    return "must not contain a backslash or a control character";
  }
  const segments = path.replace(/\/$/, "").split("/");
  if (segments.some((s) => s === "..")) return 'must not contain ".."';
  if (segments.some((s) => s === "" || s === ".")) {
    return 'must not contain an empty or "." segment';
  }
  return null;
}

/**
 * The directory under `DUCKDB_SOURCES_DIR` that browser uploads land in
 * (#595): `uploads/<workspaceId>/<sourceDir>/<name>.<ext>`. One root, never
 * a second one; the path guard resolves an upload path like any other.
 */
export const UPLOADS_DIR = "uploads";

/**
 * The extensions an upload is stored with (#595, #596): CSV, and JSON as an
 * array or one object per line. Each is a file a directory source reads
 * (`src/lib/duckdb/client.ts`); any other name is stored, and read, as CSV.
 */
export const UPLOAD_EXTENSIONS = [".csv", ".json", ".jsonl", ".ndjson"] as const;

/**
 * An Excel workbook (#597): taken by an upload, never stored. Each of its
 * sheets is converted to a CSV in the upload's directory as it arrives
 * (`src/lib/duckdb/workbook.ts`), so the directory holds only files it
 * already reads.
 */
export const WORKBOOK_EXTENSION = ".xlsx";

/** What the upload form's file picker offers: the extensions and their types. */
export const UPLOAD_ACCEPT = [
  ...UPLOAD_EXTENSIONS,
  WORKBOOK_EXTENSION,
  "text/csv",
  "application/json",
  "application/x-ndjson",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
].join(",");

/** Spreadsheet files an upload refuses by name (#597), and what each one is. */
const OTHER_SPREADSHEETS: Record<string, string> = {
  ".xls": "an older Excel workbook",
  ".xlsb": "a binary Excel workbook",
  ".xlsm": "a macro-enabled Excel workbook",
  ".ods": "an OpenDocument spreadsheet",
  ".numbers": "a Numbers spreadsheet",
};

/** Whether a file name is an Excel workbook an upload converts (#597). */
export function isWorkbookName(filename: string): boolean {
  return filename.toLowerCase().endsWith(WORKBOOK_EXTENSION);
}

/**
 * Why a spreadsheet file cannot be uploaded, or null (#597): only `.xlsx` is
 * converted, so `.xls`, `.ods`, `.numbers` and their kin are refused by name,
 * saying what to save them as, instead of failing the text check as a CSV.
 * Held by the form and again by the server.
 */
export function spreadsheetProblem(filename: string): string | null {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const what = dot > 0 ? OTHER_SPREADSHEETS[base.slice(dot).toLowerCase()] : undefined;
  return what
    ? `"${base}" is ${what}; save it as an Excel Workbook (.xlsx) or as CSV and upload that.`
    : null;
}

/**
 * Why a source in `workspaceId` may not name `path`, or null (#595): a path
 * under `uploads/` names its workspace in its second segment, and a source
 * may only name an upload directory of its own workspace, exactly
 * `uploads/<workspaceId>/<sourceDir>`. Lexical, and case-insensitive on the
 * first segment so a case-insensitive file system cannot be used to spell
 * its way past it; the server half checks again on the resolved path, on
 * save and before every execution. Names no path.
 */
export function uploadScopeProblem(path: string, workspaceId: string): string | null {
  const segments = path.replace(/\/$/, "").split("/");
  if (segments[0]?.toLowerCase() !== UPLOADS_DIR) return null;
  if (segments.length !== 3 || segments[1] !== workspaceId) {
    return `must be an upload directory of this workspace: a path under ${UPLOADS_DIR}/ may only name ${UPLOADS_DIR}/<this workspace>/<upload>`;
  }
  return null;
}

/** Whether a path names a database file (`.duckdb`) rather than a directory. */
export function duckdbLayout(path: string): "directory" | "database" {
  return path.toLowerCase().endsWith(DUCKDB_FILE_EXTENSION) ? "database" : "directory";
}

/**
 * A DuckDB source's stored config: the path, relative to
 * `DUCKDB_SOURCES_DIR`, and the same table allowlist a TimescaleDB source has.
 * A directory's tables are its files, named by their stems; a database's are
 * its own tables in `main`. `kind` is required: only the first kind may
 * default its discriminator (see `SourceConfig`).
 */
export const DuckDbConfig = z
  .object({
    kind: z.literal("duckdb"),
    path: z.string().superRefine((path, ctx) => {
      const problem = duckdbPathProblem(path);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    }),
    /** The table allowlist. Only these tables may be referenced by any SQL. */
    tables: z.array(CatalogTable).min(1).max(MAX_TABLES),
    rowFilter: RowFilter.optional(),
  })
  .strict();
export type DuckDbConfig = z.infer<typeof DuckDbConfig>;

/** The schema every DuckDB source's tables are read from. */
export const DUCKDB_SCHEMA = "main";

/**
 * What the last Test or Refresh found the engine to be: the bundled DuckDB's
 * version. Stored beside `config` in `sources.catalog_facts`, like
 * TimescaleDB's; read from the engine by the server, never from a request.
 */
export const DuckDbFacts = z.object({ duckdb: z.string().min(1).max(64) }).strict();
export type DuckDbFacts = z.infer<typeof DuckDbFacts>;

/** "DuckDB 1.5.6", or null before any Test or Refresh has said. */
export function duckDbEngine(facts: DuckDbFacts | null | undefined): string | null {
  return facts && "duckdb" in facts ? `DuckDB ${facts.duckdb}` : null;
}

/**
 * A DuckDB source as someone who may use but not manage it sees it: how many
 * tables, and whether it is a directory of files or a database. Never the
 * path, which says where on the server the files are.
 */
export interface DuckDbListing extends ListingBase {
  kind: "duckdb";
  layout: "directory" | "database";
  tableCount: number;
  /** "DuckDB 1.5.6"; null until a Test or Refresh. */
  engine: string | null;
}

/**
 * A DuckDB source, as the code that opens it holds it: its own config, and
 * no `secret_ref`. Narrowed to inside the kind's server half and the
 * implementation behind it (`src/lib/duckdb/`).
 */
export type DuckDbSourceRecord = Omit<SourceRecord, "kind" | "config" | "secretRef"> & {
  kind: "duckdb";
  config: DuckDbConfig;
  secretRef: null;
};

export const duckdb = {
  kind: "duckdb",
  label: "DuckDB",
  language: "sql",
  config: DuckDbConfig,
  facts: DuckDbFacts,
  engine: duckDbEngine,

  /** Where the files are, relative to `DUCKDB_SOURCES_DIR`, without the catalog. */
  connection(cfg: DuckDbConfig): { path: string } {
    return { path: cfg.path };
  },

  catalog(cfg: DuckDbConfig): SourceCatalog {
    return { schema: DUCKDB_SCHEMA, tables: cfg.tables.map(exposedTable) };
  },

  listing(source: SourceRecord): DuckDbListing {
    const cfg = source.config;
    if (cfg.kind !== "duckdb") throw new Error(`${source.id} is not a DuckDB source`);
    const facts = source.catalogFacts;
    return {
      id: source.id,
      workspaceId: source.workspaceId,
      name: source.name,
      kind: "duckdb",
      layout: duckdbLayout(cfg.path),
      tableCount: cfg.tables.length,
      engine: facts && "duckdb" in facts ? duckDbEngine(facts) : null,
      tombstonedAt: source.tombstonedAt,
    };
  },

  rowFilter(cfg: DuckDbConfig) {
    return cfg.rowFilter
      ? { target: cfg.rowFilter.column, claim: cfg.rowFilter.claim }
      : undefined;
  },
} as const satisfies SourceKind<
  "duckdb",
  typeof DuckDbConfig,
  SourceCatalog,
  DuckDbListing
>;
