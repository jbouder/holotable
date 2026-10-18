import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  type FileHandle,
  mkdir,
  open,
  realpath,
  rm,
  rmdir,
} from "node:fs/promises";
import { join } from "node:path";
import { config } from "@/lib/config";
import { DuckDbPathError, resolveSourcePath, SOURCES_DIR_UNSET } from "@/lib/duckdb/path";
import { log } from "@/lib/log";
import {
  convertWorkbook,
  type SkippedSheet,
  WorkbookError,
  type WorkbookLimits,
} from "@/lib/duckdb/workbook";
import { MultipartError, multipartBoundary, readMultipart } from "@/lib/multipart";
import {
  isWorkbookName,
  spreadsheetProblem,
  UPLOAD_EXTENSIONS,
  UPLOADS_DIR,
  uploadScopeProblem,
} from "@/lib/sources/kinds/duckdb";

/**
 * CSV, JSON and Excel files uploaded from the browser as a DuckDB source
 * (#595, #596, #597).
 *
 * An upload is a DuckDB source whose directory the server wrote: each file
 * lands at `DUCKDB_SOURCES_DIR/uploads/<workspaceId>/<sourceDir>/<name><ext>`,
 * under the one root, and the source stores the relative directory like any
 * other. `sourceDir` is a fresh random id; `name` is the file's own stem,
 * reduced to an identifier, because it becomes the table's name; `ext` is
 * {@link uploadExtension}'s, because the directory's reader is chosen by it.
 * An Excel workbook (`.xlsx`) is the exception: it is streamed to a
 * temporary file in the same directory, each sheet converted to a CSV beside
 * it (`./workbook.ts`), and the workbook removed; it is binary, so the text
 * check is not held against it.
 *
 * Every request is all or nothing: a file over the byte cap, one too many, a
 * file that is not text, an empty one, a stem that reduces to nothing or two
 * files with one stem each refuse the whole upload, as does a workbook a
 * sheet of which is refused, and the directory the
 * request made is removed before the answer goes back. So is a request the
 * browser cancelled. Files are streamed to disk as they arrive, never held
 * whole in memory. Every message names the variable or the person's own file
 * name, never a path on the server.
 */

/** A refused upload. Its message names no server path. */
export class UploadError extends Error {
  /** The file the refusal is about, as the person named it, when there is one. */
  readonly file?: string;
  constructor(message: string, file?: string) {
    super(message);
    this.name = "UploadError";
    this.file = file;
  }
}

/** The form field every file travels in. */
export const UPLOAD_FIELD = "files";

/** How much of each file is checked for text: the first chunk, at most this. */
export const TEXT_PROBE_BYTES = 64 * 1024;

/** The longest table name an upload makes. */
export const MAX_UPLOAD_STEM = 64;

/**
 * The most sheets one uploaded workbook may turn into tables (#597). Hidden
 * and empty sheets do not count. A constant, like the file cap's ceiling: a
 * workbook past it is a person's to split.
 */
export const MAX_WORKBOOK_SHEETS = 32;

/**
 * The most rows one sheet of an uploaded workbook may hold, its header
 * included (#597). Excel itself stops at 1,048,576.
 */
export const MAX_SHEET_ROWS = 1_000_000;

const UPLOADS_OFF = (why: string) => `Uploads are off on this server: ${why}`;

/** A workspace id that can name a directory: no separator, no dot segment. */
const WORKSPACE_DIR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The configured bounds, each its default when the value is not a positive integer. */
export function uploadLimits(): { maxBytes: number; maxFiles: number } {
  const positive = (value: number, fallback: number, max = Number.MAX_SAFE_INTEGER) =>
    Number.isSafeInteger(value) && value >= 1 && value <= max ? value : fallback;
  return {
    maxBytes: positive(config.duckdbUploadMaxBytes, 50 * 1024 * 1024),
    maxFiles: positive(config.duckdbUploadMaxFiles, 20, 200),
  };
}

/**
 * A file's name as a table name, or null when nothing is left (#595): the
 * stem (the name without its last extension), lowercased, every run of
 * anything but `[a-z0-9_]` made one `_`, trimmed of `_`, cut to
 * {@link MAX_UPLOAD_STEM}. A stem that starts with a digit gets a `t_` in
 * front, so the model can write it unquoted.
 */
export function uploadStem(filename: string): string | null {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const stem = dot >= 0 ? base.slice(0, dot) : base;
  let name = stem
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!name) return null;
  if (/^[0-9]/.test(name)) name = `t_${name}`;
  return name.slice(0, MAX_UPLOAD_STEM).replace(/_+$/, "");
}

/**
 * The extension a file is stored with (#596): its own last extension,
 * lowercased, when it is one of {@link UPLOAD_EXTENSIONS} (`.json`, `.jsonl`
 * and `.ndjson` are read as JSON), and `.csv` for any other name, which is
 * how #595 read every file.
 */
export function uploadExtension(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot).toLowerCase() : "";
  return (UPLOAD_EXTENSIONS as readonly string[]).includes(ext) ? ext : ".csv";
}

/**
 * Why `bytes`, the start of a file, is not text, or null: a NUL byte, or a
 * sequence that is not UTF-8. `final` says the file ends here; otherwise a
 * multi-byte character cut off at the end is not held against it.
 */
export function textProblem(bytes: Uint8Array, final: boolean): string | null {
  if (bytes.includes(0)) return "is not a text file (it holds a NUL byte)";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: !final });
  } catch {
    return "is not a text file (it is not UTF-8)";
  }
  return null;
}

/**
 * Why no upload can be taken on this server, or null: `DUCKDB_SOURCES_DIR`
 * is unset or unreadable, or `<root>/uploads` cannot be created or written.
 * Names the variable, never the path. `root` is for tests.
 */
export async function uploadsAvailability(
  root: string = config.duckdbSourcesDir,
): Promise<string | null> {
  if (!root)
    return UPLOADS_OFF("set DUCKDB_SOURCES_DIR to a directory the server can write.");
  let resolved: string;
  try {
    resolved = await realpath(root);
  } catch {
    return UPLOADS_OFF("DUCKDB_SOURCES_DIR does not exist or cannot be read.");
  }
  try {
    const uploads = join(resolved, UPLOADS_DIR);
    await mkdir(uploads, { recursive: true });
    await access(uploads, constants.W_OK);
    return null;
  } catch {
    return UPLOADS_OFF(
      `the server cannot write ${UPLOADS_DIR}/ under DUCKDB_SOURCES_DIR (is it mounted read-only?).`,
    );
  }
}

/**
 * One uploaded file: its table name and the bytes received. A workbook
 * (#597) also says the tables its sheets became, in sheet order, and the
 * sheets it skipped; `name` is then only its stem.
 */
export interface UploadedFile {
  name: string;
  bytes: number;
  views?: string[];
  skipped?: SkippedSheet[];
}

/** A finished upload: the source path to store, and what it holds. */
export interface UploadResult {
  path: string;
  files: UploadedFile[];
}

/** Errors from the file system carry paths: only their code is ever kept. */
function storageFailure(err: unknown): UploadError {
  const code =
    err && typeof err === "object" && "code" in err ? String(err.code) : "unknown";
  log.warn("duckdb.upload_storage_failed", { code });
  return new UploadError(
    `the server could not store the upload (${code}); nothing was kept.`,
  );
}

/**
 * Take one upload: a `multipart/form-data` body whose `files` parts are CSV
 * or JSON files, written to a fresh directory under `uploads/<workspaceId>/`. Throws
 * an {@link UploadError} (or a {@link DuckDbPathError} when uploads are off)
 * with nothing left on disk. `workspaceId` is the one the request was
 * authorized in. `root` is for tests.
 */
export async function receiveUpload(input: {
  workspaceId: string;
  contentType: string | null;
  contentLength?: number | null;
  body: ReadableStream<Uint8Array> | null;
  root?: string;
  /** For tests: smaller sheet and row caps than the constants. */
  workbookCaps?: Partial<Pick<WorkbookLimits, "maxSheets" | "maxRows">>;
}): Promise<UploadResult> {
  const root = input.root ?? config.duckdbSourcesDir;
  const off = await uploadsAvailability(root);
  if (off) throw new DuckDbPathError(root ? off : SOURCES_DIR_UNSET);
  if (!WORKSPACE_DIR.test(input.workspaceId)) {
    throw new UploadError("this workspace's id cannot name an upload directory.");
  }
  const boundary = multipartBoundary(input.contentType);
  if (!boundary) throw new UploadError("an upload must be sent as multipart/form-data.");

  const { maxBytes, maxFiles } = uploadLimits();
  // An honest Content-Length past every file at its cap is refused unread.
  const declared = input.contentLength ?? null;
  if (declared !== null && declared > maxFiles * (maxBytes + 4096) + 4096) {
    throw new UploadError(
      `the upload is larger than ${maxFiles} files of at most ${maxBytes} bytes each.`,
    );
  }

  const resolvedRoot = await realpath(root);
  const workspaceDir = join(resolvedRoot, UPLOADS_DIR, input.workspaceId);
  const sourceDir = randomBytes(8).toString("hex");
  const path = `${UPLOADS_DIR}/${input.workspaceId}/${sourceDir}`;
  // Belt: the path this request will store passes the same lexical rule a
  // saved one does, before anything is written.
  if (uploadScopeProblem(path, input.workspaceId)) {
    throw new UploadError("this workspace's id cannot name an upload directory.");
  }
  const dir = join(workspaceDir, sourceDir);
  let createdWorkspaceDir = false;
  try {
    createdWorkspaceDir = (await mkdir(workspaceDir, { recursive: true })) !== undefined;
    await mkdir(dir);
  } catch (err) {
    throw storageFailure(err);
  }

  const files: UploadedFile[] = [];
  const stems = new Set<string>();
  let handle: FileHandle | null = null;

  const cleanUp = async () => {
    await handle?.close().catch(() => {});
    handle = null;
    await rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
      storageFailure(err);
    });
    if (createdWorkspaceDir) await rmdir(workspaceDir).catch(() => {});
  };

  try {
    await readMultipart(
      input.body,
      boundary,
      async (part) => {
        if (part.name !== UPLOAD_FIELD || part.filename === null) {
          throw new UploadError(
            `every part of an upload must be a file in "${UPLOAD_FIELD}".`,
          );
        }
        const label = part.filename.split(/[\\/]/).pop() || "a file";
        if (files.length >= maxFiles) {
          throw new UploadError(`an upload holds at most ${maxFiles} files.`, label);
        }
        const other = spreadsheetProblem(part.filename);
        if (other) throw new UploadError(other, label);
        const workbook = isWorkbookName(part.filename);
        // A workbook waits here, under a dot name no directory source reads,
        // only until its sheets are converted.
        const workbookName = `.workbook-${files.length}.xlsx`;
        const stem = uploadStem(part.filename);
        if (!stem) {
          throw new UploadError(
            `"${label}" has no name left once reduced to letters, digits and _.`,
            label,
          );
        }
        if (stems.has(stem)) {
          throw new UploadError(
            `two files would both be the table "${stem}"; rename one.`,
            label,
          );
        }
        stems.add(stem);
        try {
          // A name built here, under a directory made above: not a path to
          // trace into the build (the extension is one of a fixed few).
          const name = workbook
            ? workbookName
            : `${stem}${uploadExtension(part.filename)}`;
          handle = await open(join(/* turbopackIgnore: true */ dir, name), "wx", 0o640);
        } catch (err) {
          throw storageFailure(err);
        }
        const file: UploadedFile = { name: stem, bytes: 0 };
        files.push(file);
        // The first chunk (up to TEXT_PROBE_BYTES) is held and checked
        // before anything of the file is written. A workbook is binary.
        let probe: Buffer | null = workbook ? null : Buffer.alloc(0);

        const flushProbe = async (final: boolean) => {
          if (!probe) return;
          const problem = textProblem(probe, final);
          if (problem) throw new UploadError(`"${label}" ${problem}.`, label);
          const held = probe;
          probe = null;
          await writeAll(held);
        };
        const writeAll = async (chunk: Uint8Array) => {
          try {
            await handle?.write(chunk);
          } catch (err) {
            throw storageFailure(err);
          }
        };

        return {
          async write(chunk) {
            file.bytes += chunk.byteLength;
            if (file.bytes > maxBytes) {
              throw new UploadError(
                `"${label}" is larger than ${maxBytes} bytes (DUCKDB_UPLOAD_MAX_BYTES).`,
                label,
              );
            }
            if (probe) {
              probe = Buffer.concat([probe, chunk]);
              if (probe.length >= TEXT_PROBE_BYTES) await flushProbe(false);
              return;
            }
            await writeAll(chunk);
          },
          async end() {
            if (file.bytes === 0) throw new UploadError(`"${label}" is empty.`, label);
            await flushProbe(true);
            const closing: FileHandle | null = handle;
            handle = null;
            try {
              await closing?.close();
            } catch (err) {
              throw storageFailure(err);
            }
            if (workbook) {
              const converted = await convertUpload(
                join(/* turbopackIgnore: true */ dir, workbookName),
                dir,
                stem,
                label,
                stems,
                {
                  maxSheets: input.workbookCaps?.maxSheets ?? MAX_WORKBOOK_SHEETS,
                  maxRows: input.workbookCaps?.maxRows ?? MAX_SHEET_ROWS,
                  maxBytes,
                },
              );
              file.views = converted.views;
              if (converted.skipped.length > 0) file.skipped = converted.skipped;
            }
          },
        };
      },
      { maxParts: maxFiles + 1 },
    );
    if (files.length === 0)
      throw new UploadError("choose at least one CSV, JSON or Excel file to upload.");
    // The finished directory resolves like any saved source would.
    await resolveSourcePath(path, input.workspaceId, root);
  } catch (err) {
    await cleanUp();
    if (err instanceof UploadError || err instanceof DuckDbPathError) throw err;
    if (err instanceof MultipartError) {
      throw new UploadError(`the upload was malformed or cut short: ${err.message}.`);
    }
    // A cancelled request surfaces as a stream error; nothing was kept.
    throw new UploadError("the upload did not finish; nothing was kept.");
  }
  return { path, files };
}

/**
 * Convert one received workbook into CSVs in `dir`, then remove it (#597).
 * The tables its sheets become join `taken`, so a later file cannot take
 * one. A refusal names the person's file and the sheet, never a path.
 */
async function convertUpload(
  workbookFile: string,
  dir: string,
  stem: string,
  label: string,
  taken: Set<string>,
  limits: WorkbookLimits,
): Promise<{ views: string[]; skipped: SkippedSheet[] }> {
  let result: Awaited<ReturnType<typeof convertWorkbook>>;
  try {
    result = await convertWorkbook({ file: workbookFile, dir, stem, taken, limits });
  } catch (err) {
    if (err instanceof WorkbookError) {
      throw new UploadError(`"${label}" could not be converted: ${err.message}.`, label);
    }
    throw storageFailure(err);
  }
  try {
    await rm(workbookFile, { force: true });
  } catch (err) {
    throw storageFailure(err);
  }
  for (const v of result.views) taken.add(v.view);
  log.info("duckdb.upload_workbook_converted", {
    sheets: result.views.length,
    skipped: result.skipped.length,
    rows: result.views.reduce((sum, v) => sum + v.rows, 0),
  });
  return { views: result.views.map((v) => v.view), skipped: result.skipped };
}

/**
 * Remove an uploaded source's directory, once its source has been deleted
 * or tombstoned (#595). Only a path that is an upload directory of the source's
 * own workspace, resolved by the guard, and named by no other source in it.
 * Anything else, a path under the root the operator manages included, is
 * left alone. `root` is for tests.
 */
export async function removeUpload(
  source: { workspaceId: string; path: string },
  stillNamedBy: readonly string[],
  root: string = config.duckdbSourcesDir,
): Promise<boolean> {
  const segments = source.path.replace(/\/$/, "").split("/");
  if (segments[0] !== UPLOADS_DIR || segments.length !== 3) return false;
  if (stillNamedBy.includes(source.path)) return false;
  let absolute: string;
  try {
    ({ absolute } = await resolveSourcePath(source.path, source.workspaceId, root));
  } catch {
    return false;
  }
  try {
    await rm(absolute, { recursive: true, force: true });
    return true;
  } catch (err) {
    storageFailure(err);
    return false;
  }
}
