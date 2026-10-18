import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { config } from "@/lib/config";
import {
  duckdbLayout,
  duckdbPathProblem,
  UPLOADS_DIR,
  uploadScopeProblem,
} from "@/lib/sources/kinds/duckdb";

/**
 * The path guard for DuckDB sources (#572). A source names a path, which is
 * as untrusted as a URL: whoever saved it chose it, and the files under it
 * are read by the server's own process. So a path is resolved against
 * `DUCKDB_SOURCES_DIR`, both sides through `realpath`, and refused unless what
 * it resolves to is inside the root. A `..`, an absolute path and a symlink
 * that leads out are each refused, whatever spelling got them there.
 *
 * Every refusal names the variable and never a path: an error reaches the
 * source admin's browser and the log, and the absolute path says where on
 * the server the files are.
 */

/** A path the guard refused, with a message that names no path. */
export class DuckDbPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuckDbPathError";
  }
}

/** What a source's path resolved to. Server-only; never sent to a browser or logged. */
export interface ResolvedSourcePath {
  /** `DUCKDB_SOURCES_DIR`, resolved. */
  root: string;
  /** The source's directory or database file, resolved and inside `root`. */
  absolute: string;
  layout: "directory" | "database";
}

/** The message for an unset `DUCKDB_SOURCES_DIR`, shared with the kind's checks. */
export const SOURCES_DIR_UNSET =
  "DuckDB sources are off on this server: set DUCKDB_SOURCES_DIR to the directory they may read.";

/** Whether `child` is `root` itself or under it, both already resolved. */
export function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Whether a resolved path, relative to the resolved root, is somewhere a
 * source in `workspaceId` may not read (#595): anything under `uploads/`
 * other than one of its own workspace's upload directories. Judged on where
 * the path landed, so a symlink elsewhere under the root cannot lead a
 * source into another workspace's uploads.
 */
function landsInOtherUploads(rel: string, workspaceId: string): boolean {
  const segments = rel.split(sep);
  if (segments[0]?.toLowerCase() !== UPLOADS_DIR) return false;
  return segments.length !== 3 || segments[1] !== workspaceId;
}

/**
 * Resolve a source's path inside the root, or throw a {@link DuckDbPathError}.
 *
 * The lexical rules (`duckdbPathProblem`, and the upload workspace rule) run
 * first, so a path the config would refuse never reaches the filesystem.
 * Then both the root and the joined path are `realpath`ed, which follows
 * every symlink on the way, and the result must be inside the resolved root,
 * outside every other workspace's uploads, and be what the path says it is:
 * a directory, or a regular `.duckdb` file.
 *
 * `workspaceId` is the workspace of the source the path belongs to (or is
 * about to): the one from the stored record or the authorized request, never
 * from the path. `root` is for tests; everything else reads
 * `DUCKDB_SOURCES_DIR`.
 */
export async function resolveSourcePath(
  path: string,
  workspaceId: string,
  root: string = config.duckdbSourcesDir,
): Promise<ResolvedSourcePath> {
  if (!root) throw new DuckDbPathError(SOURCES_DIR_UNSET);
  const problem = duckdbPathProblem(path) ?? uploadScopeProblem(path, workspaceId);
  if (problem) throw new DuckDbPathError(`the source path ${problem}`);

  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(root);
  } catch {
    throw new DuckDbPathError(
      "DUCKDB_SOURCES_DIR does not exist or cannot be read on this server.",
    );
  }
  let absolute: string;
  try {
    absolute = await realpath(join(resolvedRoot, path));
  } catch {
    throw new DuckDbPathError(
      "the source path does not exist under DUCKDB_SOURCES_DIR, or cannot be read.",
    );
  }
  if (!isInside(resolvedRoot, absolute) || absolute === resolvedRoot) {
    throw new DuckDbPathError("the source path resolves outside DUCKDB_SOURCES_DIR.");
  }
  if (landsInOtherUploads(relative(resolvedRoot, absolute), workspaceId)) {
    throw new DuckDbPathError(
      `the source path resolves into ${UPLOADS_DIR}/ outside this workspace's own upload directories.`,
    );
  }

  const layout = duckdbLayout(path);
  const info = await stat(absolute);
  if (layout === "directory" && !info.isDirectory()) {
    throw new DuckDbPathError(
      "the source path is not a directory; a database file must end in .duckdb.",
    );
  }
  if (layout === "database" && !info.isFile()) {
    throw new DuckDbPathError("the source path ends in .duckdb but is not a file.");
  }
  return { root: resolvedRoot, absolute, layout };
}

/** The most entries the path picker is offered; a root with more is cut, sorted. */
export const MAX_LISTED_PATHS = 500;

/** One thing directly under the root a source could name: a name, never a path. */
export interface ListedSourcePath {
  /** The entry's name, which is also the relative path a source stores. */
  name: string;
  layout: "directory" | "database";
}

/**
 * What a source admin may pick from (#573): the directories and `.duckdb`
 * files directly under `DUCKDB_SOURCES_DIR`, by name. No recursion, no
 * absolute path, nothing hidden (a leading `.`), and nothing the path guard
 * would refuse: a symlink counts only when it resolves inside the root, and
 * an entry only when its name says what it is (a directory not ending in
 * `.duckdb`, a regular file that does). Never `uploads/` (#595), nor
 * anything that resolves into it. A listing is a menu; saving still runs
 * {@link resolveSourcePath}.
 *
 * Throws a {@link DuckDbPathError}, naming the variable and never a path, when
 * the root is unset or unreadable. `root` is for tests.
 */
export async function listSourcePaths(
  root: string = config.duckdbSourcesDir,
): Promise<ListedSourcePath[]> {
  if (!root) throw new DuckDbPathError(SOURCES_DIR_UNSET);
  let resolvedRoot: string;
  let names: string[];
  try {
    resolvedRoot = await realpath(root);
    names = await readdir(resolvedRoot);
  } catch {
    throw new DuckDbPathError(
      "DUCKDB_SOURCES_DIR does not exist or cannot be read on this server.",
    );
  }
  const listed: ListedSourcePath[] = [];
  for (const name of names.sort()) {
    if (listed.length >= MAX_LISTED_PATHS) break;
    // Uploads (#595) are each workspace's own, reached through their
    // source, never offered as a path to pick.
    if (name.startsWith(".") || duckdbPathProblem(name)) continue;
    if (name.toLowerCase() === UPLOADS_DIR) continue;
    let absolute: string;
    try {
      absolute = await realpath(join(resolvedRoot, name));
    } catch {
      continue;
    }
    if (!isInside(resolvedRoot, absolute) || absolute === resolvedRoot) continue;
    if (relative(resolvedRoot, absolute).split(sep)[0]?.toLowerCase() === UPLOADS_DIR) {
      continue;
    }
    const info = await stat(absolute).catch(() => null);
    const layout = duckdbLayout(name);
    if (layout === "directory" ? info?.isDirectory() : info?.isFile()) {
      listed.push({ name, layout });
    }
  }
  return listed;
}
