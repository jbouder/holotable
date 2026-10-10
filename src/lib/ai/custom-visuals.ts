import type { z } from "zod";
import { compileVegaLite } from "@/lib/vega/compile";

/**
 * A generated custom visual must compile (#405), and a model that writes one
 * that does not gets the same one repair round as any schema failure (#21).
 *
 * The IR's walk already holds a spec's shape on every parse; compiling needs
 * Vega-Lite, which is asynchronous to load, so it is a refinement on the
 * generation schema alone, never on the IR. The AI SDK validates with
 * `safeParseAsync`, so a compile failure fails the stream like any other
 * issue, `describeFailure` lists it, and the repair prompt carries the
 * compiler's message. The refinement returns nothing at all for an output
 * with no custom visual, so a synchronous parse of one still works.
 */

interface PanelLike {
  viz?: unknown;
  options?: { spec?: unknown };
}

function customVisuals(value: unknown): { spec: unknown; path: (string | number)[] }[] {
  if (typeof value !== "object" || value === null) return [];
  const panels = (value as { panels?: unknown }).panels;
  const list: [PanelLike, (string | number)[]][] = Array.isArray(panels)
    ? panels.map((p, i) => [p as PanelLike, ["panels", i]])
    : [[value as PanelLike, []]];
  return list
    .filter(([p]) => p?.viz === "vega")
    .map(([p, path]) => ({ spec: p.options?.spec, path: [...path, "options", "spec"] }));
}

export function withCompiledCustomVisuals<S extends z.ZodType>(schema: S): S {
  return schema.superRefine((value, ctx) => {
    const visuals = customVisuals(value);
    if (visuals.length === 0) return;
    return (async () => {
      for (const { spec, path } of visuals) {
        const result = await compileVegaLite(spec);
        if (!result.ok) {
          ctx.addIssue({
            code: "custom",
            message: `the Vega-Lite spec does not compile: ${result.error}`,
            path,
          });
        }
      }
    })();
  }) as unknown as S;
}
