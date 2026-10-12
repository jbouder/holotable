import type * as DuckDbApi from "@duckdb/node-api";
import { log } from "@/lib/log";

/**
 * The DuckDB native binding, loaded the first time a DuckDB source needs it
 * (#572), never at import.
 *
 * `@duckdb/node-api` is a native module with one prebuilt binding per
 * platform. A server whose platform has none (or whose image left it out)
 * must still boot and serve every other kind, so nothing imports the package
 * statically: a failed load is remembered, and the kind's checks, Test and
 * every execution say {@link DUCKDB_UNAVAILABLE} instead of throwing from
 * the module graph. "The binding and the image" in
 * `docs/src/content/docs/architecture/data-model.md` records the decision.
 */

export type DuckDbBinding = typeof DuckDbApi;

/** What a source admin and a panel are told when the binding did not load. */
export const DUCKDB_UNAVAILABLE =
  "DuckDB is not available on this server: its native binding did not load for this platform.";

const importBinding = (): Promise<DuckDbBinding> => import("@duckdb/node-api");

let loader: () => Promise<DuckDbBinding> = importBinding;
let loading: Promise<DuckDbBinding | null> | undefined;

/** The binding, or null when it cannot be loaded on this server. Loaded once. */
export function duckdbBinding(): Promise<DuckDbBinding | null> {
  loading ??= loader().then(
    (binding) => binding,
    (err: unknown) => {
      // The error names the package's install path, which is not worth a
      // line of its own; its code says which failure it was.
      const code = (err as { code?: unknown })?.code;
      log.warn("duckdb binding did not load; DuckDB sources are unavailable", {
        code: typeof code === "string" ? code : "unknown",
      });
      return null;
    },
  );
  return loading;
}

/**
 * Replace how the binding is loaded, and forget any earlier load. For tests
 * that simulate a platform without one; `null` restores the real import.
 */
export function setDuckDbLoaderForTests(
  next: (() => Promise<DuckDbBinding>) | null,
): void {
  loader = next ?? importBinding;
  loading = undefined;
}
