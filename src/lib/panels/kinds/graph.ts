import { z } from "zod";
import type { GraphDirection } from "@/lib/graph/layout";
import { GRAPH_SYMBOLS, SYMBOL_SIZE_MAX, SYMBOL_SIZE_MIN } from "@/lib/graph/symbols";
import { NumberFields } from "@/lib/panels/presentation";
import { definePanelKind } from "@/lib/panels/types";

const Column = z.string().min(1).max(128);

/** The deepest path a graph takes as columns. */
export const GRAPH_PATH_MAX = 8;
/** The most groups a `symbols` mapping names. */
export const GRAPH_SYMBOL_GROUPS_MAX = 32;

/**
 * How a graph is laid out: `tree` (#623), and `dag`, a layered directed graph
 * for a node with several parents or a cycle (#624). The force layout joins
 * this list on the same options (#625).
 */
export const GRAPH_LAYOUTS = ["tree", "dag"] as const;
/** Which way a directed graph's layers run (#624). */
export const GRAPH_DIRECTIONS = ["LR", "TB"] as const satisfies readonly GraphDirection[];
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
    /**
     * Which way a directed graph's layers run, left to right or top to
     * bottom; by default `orient`'s nearer one, else `LR`.
     */
    direction: z.enum(GRAPH_DIRECTIONS).optional(),
    /** A directed graph writes each edge's value on it. */
    edgeLabels: z.boolean().optional(),
    /** A directed graph's edges are gently curved; `true` by default. */
    curve: z.boolean().optional(),
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

/**
 * What a click carries besides its row's columns, under these names on any
 * graph: on a node (#623) its name, its (first) parent's, its group and its
 * value; on a directed graph's edge (#624) its `source`, `target` and value.
 */
export const GRAPH_DATUM_COLUMNS = [
  "node",
  "parent",
  "group",
  "value",
  "source",
  "target",
] as const;

/** Structure: what points at what, drawn as a tree of nodes and edges (#623). */
export const graph = definePanelKind({
  kind: "graph",
  summary:
    "Structure: nodes and edges drawn as a tree, or as a layered directed graph where a node has several parents or edges form a cycle, from one row per edge (`options.source` → `options.target`) or from path columns, with collapsible branches, arrows and network icons as symbols.",
  promptHint:
    'what points at what (a service and what it calls, a schema\'s tables and their columns, a folder tree): return one row per edge, parent and child columns, named in options.source and options.target, with an optional numeric options.value and a text options.group that colors nodes by category; or one row per leaf with options.path columns, top level first, as for a treemap. options.layout "tree" (default) when every node has one parent, with options.orient "LR" (default), "TB", "RL", "BT" or "radial"; options.layout "dag" when a node has several parents or the edges can form a cycle (a dependency graph, a data lineage, tables sharing a dimension, a state machine, a network with redundant links), with options.direction "LR" (default) or "TB", options.edgeLabels true to write each edge\'s value on it, and options.curve false for straight edges. A tree whose rows turn out not to be one is drawn as a dag with a notice. For an infrastructure or service map, give nodes icons: options.symbol (one of circle, rect, roundRect, triangle, diamond, pin, arrow, server, database, cloud, router, switch, firewall, loadBalancer, queue, cache, storage, user, service) and options.symbols mapping a group value to one, e.g. {"service": "server", "store": "database"}. Use \'treemap\' when the question is share, not structure.',
  promqlHint:
    'an instant query aggregated by both ends of an edge, \'sum by (caller, callee) (rate(calls_total[5m]))\', with options.source "caller", options.target "callee" and options.value "value".',
  canvas: true,
  timeBrush: false,
  skeleton: "blocks",
  query: "required",
  options: GraphOptions,
  optionGroups: ["graph", "number"],
  datumColumns: GRAPH_DATUM_COLUMNS,
});
