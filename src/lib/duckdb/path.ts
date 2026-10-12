import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { config } from "@/lib/config";
import { duckdbLayout, duckdbPathProblem } from "@/lib/sources/kinds/duckdb";

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
 * Resolve a source's path inside the root, or throw a {@link DuckDbPathError}.
 *
 * The lexical rules (`duckdbPathProblem`) run first, so a path the config
 * would refuse never reaches the filesystem. Then both the root and the
 * joined path are `realpath`ed, which follows every symlink on the way, and
 * the result must be inside the resolved root and be what the path says it
 * is: a directory, or a regular `.duckdb` file.
 *
 * `root` is for tests; everything else reads `DUCKDB_SOURCES_DIR`.
 */
export async function resolveSourcePath(
  path: string,
  root: string = config.duckdbSourcesDir,
): Promise<ResolvedSourcePath> {
  if (!root) throw new DuckDbPathError(SOURCES_DIR_UNSET);
  const problem = duckdbPathProblem(path);
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
