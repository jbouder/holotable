import { z } from "zod";
import { definePanelKind } from "@/lib/panels/types";
import { VEGA_DATA, vegaLiteIssues } from "@/lib/vega/walk";

/**
 * A custom visual's options (#405): one Vega-Lite spec, held to the
 * structural walk (`src/lib/vega/walk.ts`) wherever a panel is parsed. The
 * spec is plain JSON; it is never code, and it has no data of its own.
 */
export const VegaOptions = z
  .object({
    spec: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((o, ctx) => {
    for (const issue of vegaLiteIssues(o.spec)) {
      ctx.addIssue({
        code: "custom",
        message: issue.message,
        path: ["spec", ...issue.path],
      });
    }
  });
export type VegaOptions = z.infer<typeof VegaOptions>;

/** A view no registered kind draws, as a Vega-Lite spec over the panel's rows (#405). */
export const vega = definePanelKind({
  kind: "vega",
  summary:
    'A custom visual: a Vega-Lite spec in `options.spec`, drawn over the panel\'s rows (`"data": {"name": "rows"}`). For a view no other kind draws.',
  promptHint:
    'only when no other kind fits (a band with a rule, small multiples, a dot plot, a slope chart): options.spec is a Vega-Lite spec whose "data" is {"name": "rows"}, encoding the query\'s own columns; colors are token names (success, warning, danger, info, neutral, orange, purple, teal) or palette-0 to palette-5, never hex; no url, href, image, datasets or config.',
  canvas: false,
  image: true,
  timeBrush: false,
  skeleton: "chart",
  query: "required",
  options: VegaOptions,
  starterOptions: () => ({
    spec: {
      data: { ...VEGA_DATA },
      mark: "point",
      encoding: {},
    },
  }),
  // The compiler is the server's last word: a spec that does not compile is
  // refused where it is saved, with its own message (#405 phase 2).
  check: async (options) => {
    const { compileVegaLite } = await import("@/lib/vega/compile");
    const spec = (options as { spec?: unknown } | undefined)?.spec;
    const result = await compileVegaLite(spec);
    return result.ok ? undefined : `the Vega-Lite spec does not compile: ${result.error}`;
  },
});
