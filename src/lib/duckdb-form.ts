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
