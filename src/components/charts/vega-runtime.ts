import type { Config, Loader, Spec, View } from "vega";

/**
 * The Vega runtime a custom visual is drawn with (#405), built so that it
 * runs under the production Content-Security-Policy and can reach nothing.
 *
 * - **No code from strings.** Vega's default expression compiler builds each
 *   expression with `new Function`, which `script-src` without
 *   `'unsafe-eval'` refuses. Parsing with `ast: true` and evaluating with
 *   `vega-interpreter` walks the expression tree instead; the spike ran a
 *   three-layer chart with `Function` itself made to throw, and it was never
 *   called. `test/vega-runtime.test.ts` runs the same check.
 * - **No network.** The view's loader refuses every load and every sanitize,
 *   so a `data.url` or an image href that got past validation fetches
 *   nothing. Validation refuses them first (#405 phase 2); this is the floor
 *   under it.
 * - **One dataset.** The query's rows are bound as {@link VEGA_DATASET} and
 *   replaced with a changeset on every tick, so a view is built once per
 *   spec and data merges into it (invariant 11).
 * - **Loaded on demand.** Vega is reached only through {@link loadVega}'s
 *   dynamic import, so its chunk (about 270 KB gzipped) loads with the first
 *   custom visual on a page and never with a dashboard that has none. Only
 *   this module and `src/lib/vega/compile.ts` name Vega at all.
 */

/** The one dataset a custom visual reads: the panel's rows. */
export const VEGA_DATASET = "rows";

type VegaModule = typeof import("vega");
type InterpreterModule = typeof import("vega-interpreter");

export interface VegaRuntime {
  vega: VegaModule;
  expr: InterpreterModule["expressionInterpreter"];
}

let loading: Promise<VegaRuntime> | undefined;

/** Vega and its interpreter, imported once per page. */
export function loadVega(): Promise<VegaRuntime> {
  loading ??= Promise.all([import("vega"), import("vega-interpreter")]).then(
    ([vega, interpreter]) => ({ vega, expr: interpreter.expressionInterpreter }),
  );
  return loading;
}

/** A loader that refuses everything: no URL, file or data URI is ever read. */
export function refusingLoader(vega: VegaModule): Loader {
  const refused = vega.loader();
  const refuse = async (uri: string): Promise<never> => {
    throw new Error(`a custom visual cannot load ${JSON.stringify(uri)}`);
  };
  refused.load = refuse;
  refused.sanitize = refuse;
  refused.http = refuse;
  refused.file = refuse;
  return refused;
}

export interface VegaViewOptions {
  /** The theme, as Vega config: colors from the design tokens. */
  config?: Config;
  /** `canvas` in the browser; `none` for a headless view (tests, export). */
  renderer?: "canvas" | "svg" | "none";
  /** Where the view draws; none for a headless one. */
  container?: HTMLElement;
}

/** A view of a compiled spec over these rows, run once. */
export async function createVegaView(
  spec: Spec,
  rows: readonly Record<string, unknown>[],
  options: VegaViewOptions = {},
): Promise<View> {
  const { vega, expr } = await loadVega();
  const runtime = vega.parse(spec, options.config, { ast: true });
  const view = new vega.View(runtime, {
    expr,
    loader: refusingLoader(vega),
    renderer: options.renderer ?? "canvas",
    ...(options.container ? { container: options.container } : {}),
    hover: true,
  });
  // A spec that reads no rows (validation refuses one, phase 2) still draws.
  if (spec.data?.some((d) => d.name === VEGA_DATASET)) {
    view.data(VEGA_DATASET, rows as object[]);
  }
  await view.runAsync();
  return view;
}

/** The rows replaced in place: a merge, never a rebuild. */
export async function replaceVegaRows(
  view: View,
  rows: readonly Record<string, unknown>[],
): Promise<void> {
  await view
    .change(
      VEGA_DATASET,
      view
        .changeset()
        .remove(() => true)
        .insert(rows as object[]),
    )
    .runAsync();
}
