import { apiErrorFromThrown, readApiError } from "@/lib/errors";
import {
  type AllowlistState,
  collectFieldErrors,
  type DiscoverOutcome,
  type FieldErrors,
  readDiscovery,
} from "@/lib/source-form";
import { DuckDbConfig, duckdbPathProblem } from "@/lib/sources/kinds/duckdb";

/**
 * The DuckDB source form, as data (#573), in the shape of
 * `src/lib/source-form.ts`, whose allowlist functions it shares: the state is
 * the path as typed and the tables picked, and the conversion back is the
 * only place the two meet. Pure, apart from the two fetch helpers at the
 * bottom. The server re-validates everything it is sent, and resolves the
 * path through its guard before anything is opened.
 */

/**
 * The DuckDB form's state: the path, as typed or picked, and the same
 * allowlist the TimescaleDB form edits. A row filter has no control here and
 * rides along unchanged, so editing a source does not drop one.
 */
export interface DuckDbFormState extends AllowlistState {
  path: string;
  rowFilter?: DuckDbConfig["rowFilter"];
}

export function emptyDuckDbFormState(): DuckDbFormState {
  return { path: "", tables: [] };
}

export function duckdbFormStateFromConfig(config: DuckDbConfig): DuckDbFormState {
  return {
    path: config.path,
    tables: config.tables,
    ...(config.rowFilter ? { rowFilter: config.rowFilter } : {}),
  };
}

export type DuckDbFormResult =
  | { ok: true; config: DuckDbConfig }
  | { ok: false; errors: FieldErrors };

/**
 * The path's error, if any, by the config's own lexical rule: what discovery
 * needs before it asks, and the first half of what saving checks. Whether
 * the path exists under `DUCKDB_SOURCES_DIR` is the server's to say.
 */
export function duckdbPathErrors(path: string): FieldErrors {
  const trimmed = path.trim();
  if (!trimmed) return { path: "Choose a directory or a .duckdb file." };
  const problem = duckdbPathProblem(trimmed);
  return problem ? { path: `The path ${problem}.` } : {};
}

/** Build the DuckDB config a state describes, or the per-field reasons it cannot. */
export function duckdbConfigFromFormState(state: DuckDbFormState): DuckDbFormResult {
  const errors = duckdbPathErrors(state.path);
  const parsed = DuckDbConfig.safeParse({
    kind: "duckdb",
    path: state.path.trim(),
    tables: state.tables,
    ...(state.rowFilter ? { rowFilter: state.rowFilter } : {}),
  });
  if (parsed.success && Object.keys(errors).length === 0) {
    return { ok: true, config: parsed.data };
  }
  if (!parsed.success) collectFieldErrors(parsed.error.issues, errors);
  return { ok: false, errors };
}

/**
 * Ask the server which tables are under a path. The path is resolved by the
 * server's guard; a refusal or an engine error arrives as a `200` body with a
 * message that names no path, and becomes a `validation` error here.
 */
export async function discoverDuckDbTables(
  input: { workspaceId: string; path: string },
  init?: { signal?: AbortSignal },
): Promise<DiscoverOutcome> {
  try {
    const res = await fetch("/api/sources/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "duckdb", ...input }),
      signal: init?.signal,
    });
    if (!res.ok) return { ok: false, error: await readApiError(res) };
    return readDiscovery(await res.json());
  } catch (err) {
    return { ok: false, error: apiErrorFromThrown(err) };
  }
}

/** One entry the path picker offers: a name directly under the root. */
export interface DuckDbPathOption {
  name: string;
  layout: "directory" | "database";
}

export type DuckDbPathsOutcome =
  | { ok: true; paths: DuckDbPathOption[] }
  | { ok: false; error: string };

/** The path picker's menu, trusted no further than its shape. */
export async function listDuckDbPaths(
  workspaceId: string,
  init?: { signal?: AbortSignal },
): Promise<DuckDbPathsOutcome> {
  try {
    const res = await fetch(
      `/api/sources/duckdb/paths?workspaceId=${encodeURIComponent(workspaceId)}`,
      { signal: init?.signal },
    );
    if (!res.ok) return { ok: false, error: (await readApiError(res)).error };
    const body = (await res.json()) as Record<string, unknown>;
    if (body.ok !== true) {
      return {
        ok: false,
        error: typeof body.error === "string" ? body.error : "could not list the paths",
      };
    }
    const paths = (Array.isArray(body.paths) ? body.paths : []).filter(
      (p): p is DuckDbPathOption =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as DuckDbPathOption).name === "string" &&
        ((p as DuckDbPathOption).layout === "directory" ||
          (p as DuckDbPathOption).layout === "database"),
    );
    return { ok: true, paths };
  } catch (err) {
    return { ok: false, error: apiErrorFromThrown(err).error };
  }
}

/* -------------------------------------------------------------------------- */
/* Uploads (#595)                                                             */
/* -------------------------------------------------------------------------- */

/** The sample the upload form offers, served by the app itself. */
export const SAMPLE_UPLOAD_URL = "/samples/household-expenses.csv";
export const SAMPLE_UPLOAD_NAME = "household-expenses.csv";

/** One file the server stored: its table name and size. */
export interface UploadedFile {
  name: string;
  bytes: number;
}

export type UploadOutcome =
  | { ok: true; path: string; files: UploadedFile[] }
  | { ok: false; error: string; file?: string; cancelled?: boolean };

/** A size for people: `812 B`, `14.1 KB`, `3.2 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Why these files cannot be sent, or null: the same bounds the server holds
 * an upload to, checked first so a file that would be refused is never sent.
 * The server checks again (and the text rule only it can).
 */
export function uploadFilesProblem(
  files: readonly { name: string; size: number }[],
  limits: { maxBytes: number; maxFiles: number },
): { error: string; file?: string } | null {
  if (files.length === 0) return { error: "Choose at least one CSV file." };
  if (files.length > limits.maxFiles) {
    return { error: `An upload holds at most ${limits.maxFiles} files.` };
  }
  for (const file of files) {
    if (file.size === 0) return { error: `"${file.name}" is empty.`, file: file.name };
    if (file.size > limits.maxBytes) {
      return {
        error: `"${file.name}" is larger than ${formatBytes(limits.maxBytes)}, this server's limit.`,
        file: file.name,
      };
    }
  }
  return null;
}

/**
 * How many bytes of each file have been sent, from the request's own count.
 * The request is the files plus a little multipart framing, so its total is
 * scaled to the files' before it is shared out in order.
 */
export function perFileSent(
  sizes: readonly number[],
  loaded: number,
  total: number,
): number[] {
  const files = sizes.reduce((sum, size) => sum + size, 0);
  let left = total > 0 ? Math.min(files, (loaded / total) * files) : 0;
  return sizes.map((size) => {
    const sent = Math.min(size, left);
    left -= sent;
    return Math.round(sent);
  });
}

/**
 * Send files to `POST /api/sources/duckdb/uploads`. Through
 * `XMLHttpRequest`, not `fetch`, because only its `upload.onprogress`
 * reports bytes sent in every browser. `onSent` fires once the last byte has
 * gone and the server is checking and writing. `abort` cancels it; the
 * server keeps nothing of a request that did not finish.
 */
export function uploadDuckDbFiles(
  workspaceId: string,
  files: readonly File[],
  handlers: {
    onProgress?: (loaded: number, total: number) => void;
    onSent?: () => void;
  } = {},
): { done: Promise<UploadOutcome>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const body = new FormData();
  for (const file of files) body.append("files", file, file.name);
  const done = new Promise<UploadOutcome>((resolve) => {
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) handlers.onProgress?.(event.loaded, event.total);
    };
    xhr.upload.onload = () => handlers.onSent?.();
    xhr.onload = () => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
        // Not JSON: a proxy's page, say. Said below by the status.
      }
      if (parsed.ok === true && typeof parsed.path === "string") {
        const stored = (Array.isArray(parsed.files) ? parsed.files : []).filter(
          (f): f is UploadedFile =>
            typeof f === "object" &&
            f !== null &&
            typeof (f as UploadedFile).name === "string" &&
            typeof (f as UploadedFile).bytes === "number",
        );
        resolve({ ok: true, path: parsed.path, files: stored });
        return;
      }
      resolve({
        ok: false,
        error:
          typeof parsed.error === "string"
            ? parsed.error
            : `The upload failed (HTTP ${xhr.status}).`,
        ...(typeof parsed.file === "string" ? { file: parsed.file } : {}),
      });
    };
    xhr.onerror = () =>
      resolve({ ok: false, error: "The upload could not reach the server." });
    xhr.onabort = () =>
      resolve({
        ok: false,
        cancelled: true,
        error: "Upload cancelled. Nothing was kept on the server.",
      });
  });
  xhr.open(
    "POST",
    `/api/sources/duckdb/uploads?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  xhr.send(body);
  return { done, abort: () => xhr.abort() };
}

/** The sample file, fetched from the app's own URL, as a file to upload. */
export async function sampleUploadFile(): Promise<File | null> {
  try {
    const res = await fetch(SAMPLE_UPLOAD_URL);
    if (!res.ok) return null;
    return new File([await res.blob()], SAMPLE_UPLOAD_NAME, { type: "text/csv" });
  } catch {
    return null;
  }
}
