import { z } from "zod";
import { GRAPH_SYMBOLS, SYMBOL_SIZE_MAX, SYMBOL_SIZE_MIN } from "@/lib/graph/symbols";
import { NumberFields } from "@/lib/panels/presentation";
import { definePanelKind } from "@/lib/panels/types";

const Column = z.string().min(1).max(128);

/** The deepest path a graph takes as columns. */
export const GRAPH_PATH_MAX = 8;
/** The most groups a `symbols` mapping names. */
export const GRAPH_SYMBOL_GROUPS_MAX = 32;

/**
 * How a graph is laid out. `tree` is the first (#623); the directed-graph,
 * force and Sankey layouts join this list on the same options (#624, #625).
 */
export const GRAPH_LAYOUTS = ["tree"] as const;
/** Which way a tree grows: left to right, top to bottom, …, or out from its root. */
export const GRAPH_ORIENTS = ["LR", "TB", "RL", "BT", "radial"] as const;

/** A node symbol: a name on the allowlist, never a `path://` or `image://`. */
export const GraphSymbolName = z.enum(GRAPH_SYMBOLS);

export const GraphOptions = z
  .object({
    /** How the graph is drawn; `tree` by default. */
    layout: z.enum(GRAPH_LAYOUTS).optional(),
    /** Which way the tree grows; `LR` by default. */
    orient: z.enum(GRAPH_ORIENTS).optional(),
    /** The parent column of an edge row; by default the first text column. */
    source: Column.optional(),
    /** The child column of an edge row; by default the second text column. */
    target: Column.optional(),
    /** A number shown on each node: its incoming edge's, summed over rows. */
    value: Column.optional(),
    /** A text column that colors (and picks the symbol of) each edge's target. */
    group: Column.optional(),
    /**
     * The path from the top level down, as columns, one row per leaf: the
     * treemap's shape. When set, `source` and `target` are not read.
     */
    path: z.array(Column).min(1).max(GRAPH_PATH_MAX).optional(),
    /** Levels open at first draw; by default every level. */
    collapseDepth: z.number().int().min(1).max(32).optional(),
    /** Every node's symbol, unless `symbols` names its group's; `circle` by default. */
    symbol: GraphSymbolName.optional(),
    /** A symbol per `group` value: `{ "service": "server", "store": "database" }`. */
    symbols: z
      .record(z.string().min(1).max(128), GraphSymbolName)
      .refine((m) => Object.keys(m).length <= GRAPH_SYMBOL_GROUPS_MAX, {
        message: `at most ${GRAPH_SYMBOL_GROUPS_MAX} groups`,
      })
      .optional(),
    /** The symbol's size in pixels; by default 10 for a shape, 24 for an icon. */
    symbolSize: z.number().min(SYMBOL_SIZE_MIN).max(SYMBOL_SIZE_MAX).optional(),
    /** How a value is written on a node and in its tooltip. */
    ...NumberFields,
  })
  .strict();
export type GraphOptions = z.infer<typeof GraphOptions>;

/** Structure: what points at what, drawn as a tree of nodes and edges (#623). */
export const graph = definePanelKind({
  kind: "graph",
  summary:
    "Structure: nodes and edges drawn as a tree, from one row per edge (`options.source` → `options.target`) or from path columns, left to right, top to bottom or radial, with collapsible branches and network icons as symbols.",
  promptHint:
    'what points at what (a service and what it calls, a schema\'s tables and their columns, a folder tree): return one row per edge, parent and child columns, named in options.source and options.target, with an optional numeric options.value and a text options.group that colors nodes by category; or one row per leaf with options.path columns, top level first, as for a treemap. Every node needs one parent: a node with two parents or a cycle is refused. options.orient "LR" (default), "TB", "RL", "BT" or "radial". For an infrastructure or service map, give nodes icons: options.symbol (one of circle, rect, roundRect, triangle, diamond, pin, arrow, server, database, cloud, router, switch, firewall, loadBalancer, queue, cache, storage, user, service) and options.symbols mapping a group value to one, e.g. {"service": "server", "store": "database"}. Use \'treemap\' when the question is share, not structure.',
  promqlHint:
    'an instant query aggregated by both ends of an edge, \'sum by (caller, callee) (rate(calls_total[5m]))\', with options.source "caller", options.target "callee" and options.value "value".',
  canvas: true,
  timeBrush: false,
  skeleton: "blocks",
  query: "required",
  options: GraphOptions,
  optionGroups: ["graph", "number"],
});
