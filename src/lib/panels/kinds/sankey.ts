import { z } from "zod";
import { GRAPH_PATH_MAX } from "@/lib/panels/kinds/graph";
import { NumberFields } from "@/lib/panels/presentation";
import { definePanelKind } from "@/lib/panels/types";

const Column = z.string().min(1).max(128);

/** Which way a Sankey's flows run: left to right, or top to bottom. */
export const SANKEY_ORIENTS = ["LR", "TB"] as const;

/**
 * A Sankey's options (#625). Its rows are the graph's (one per edge, or path
 * columns), read the same way, but every edge must carry a volume, so
 * `value` is required, and the flows cannot cycle, which the renderer refuses
 * naming a node on the cycle. Symbols do not apply: a node is a bar.
 */
export const SankeyOptions = z
  .object({
    /** Which way the flows run; `LR` by default. */
    orient: z.enum(SANKEY_ORIENTS).optional(),
    /** The column a flow leaves; by default the first text column. */
    source: Column.optional(),
    /** The column a flow reaches; by default the second text column. */
    target: Column.optional(),
    /** The volume of each flow, summed over rows with the same ends. Required. */
    value: Column,
    /** A text column that colors each flow's target by category. */
    group: Column.optional(),
    /**
     * The stages from first to last, as columns, one row per path: each
     * column's values are the nodes of one stage, a flow running between
     * neighboring columns. When set, `source` and `target` are not read.
     */
    path: z.array(Column).min(2).max(GRAPH_PATH_MAX).optional(),
    /** How a value is written on a node and in its tooltip. */
    ...NumberFields,
  })
  .strict();
export type SankeyOptions = z.infer<typeof SankeyOptions>;

/**
 * What a click carries besides its row's columns: on a node its name, group
 * and value (the larger of what enters and what leaves it); on a flow its
 * `source`, `target` and value, as on a graph's edge.
 */
export const SANKEY_DATUM_COLUMNS = [
  "node",
  "group",
  "value",
  "source",
  "target",
] as const;

/** How much flows where: weighted, directed flows between stages (#625). */
export const sankey = definePanelKind({
  kind: "sankey",
  summary:
    "Flow: how much moves from where to where, as bands whose width is the volume, between nodes in stages left to right or top to bottom, from one row per edge (`options.source` → `options.target`, `options.value` required) or from path columns, one stage per column. Flows cannot form a cycle.",
  promptHint:
    'how much flows where (requests from service to route to status, bytes from source to sink, users through the steps of a funnel, cost from team to service to resource): return one row per path with one text column per stage and one numeric volume, already aggregated, named in options.path (first stage first, at least two) and options.value; or one row per edge, from and to columns named in options.source and options.target, with options.value. options.value is required, and rows with the same ends are summed, so return counts and totals, not averages. Flows must not cycle: when an edge can point back (a state machine, retries), use \'graph\' with options.layout "dag". options.orient "LR" (default) or "TB". Use \'graph\' when the question is structure or who talks to whom, not volume.',
  promqlHint:
    'an instant query aggregated by both ends, \'sum by (source, destination) (rate(bytes_total[5m]))\', with options.source "source", options.target "destination" and options.value "value"; or by the stages, with options.path and options.value "value".',
  canvas: true,
  timeBrush: false,
  skeleton: "blocks",
  query: "required",
  options: SankeyOptions,
  optionGroups: ["sankey", "number"],
  // `value` is required: a panel switched to a Sankey starts with the usual name.
  starterOptions: () => ({ value: "value" }),
  datumColumns: SANKEY_DATUM_COLUMNS,
});
