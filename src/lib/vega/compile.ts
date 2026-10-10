import type { Spec } from "vega";
import type { TopLevelSpec } from "vega-lite";

/**
 * Vega-Lite to Vega, on the server (#405).
 *
 * A custom visual's spec is accepted only once it compiles, so the author (or
 * the model's repair round) hears the compiler's own message at the point the
 * spec is saved, not a blank panel later. Compiling is pure: it reads the
 * spec and returns another, with no view, no DOM and no network. The spike
 * measured about 1.3 ms for a three-layer chart, cheap enough to run at every
 * acceptance point.
 *
 * This is the one module besides the browser runtime that imports Vega;
 * `test/vega-runtime.test.ts` holds that list. The import is dynamic, as the
 * runtime's is: Vega-Lite's entry imports Vega, and Vega's Node canvas
 * module awaits at its top level, which a CommonJS caller (this repository's
 * TypeScript, under the test runner) cannot load statically.
 */

export type VegaCompileResult = { ok: true; spec: Spec } | { ok: false; error: string };

let compiler: Promise<typeof import("vega-lite")> | undefined;

/** The compiler's output for a spec, or its message. Never throws. */
export async function compileVegaLite(spec: unknown): Promise<VegaCompileResult> {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    return { ok: false, error: "a Vega-Lite spec is a JSON object" };
  }
  try {
    compiler ??= import("vega-lite");
    const { compile } = await compiler;
    return { ok: true, spec: compile(spec as TopLevelSpec).spec };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
