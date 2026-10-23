---
title: Graph layout
description: Why the graph panel's directed-graph layout is a small layered algorithm Holotable owns rather than dagre or elkjs, and what was measured to decide it.
sidebar:
  order: 8
---

The `graph` panel kind draws a tree with ECharts' own tree series
([#623](https://github.com/jbouder/holotable/issues/623)). Data where a node has
several parents, or where edges form a cycle, is not a tree: a dependency
graph, a data lineage, a schema whose fact tables share their dimensions, a
network with redundant links. ECharts' `graph` series lays that out only as
`force` or `circular`, neither of which reads as "this flows into that". So
`layout: "dag"` ([#624](https://github.com/jbouder/holotable/issues/624))
computes positions itself and hands them to a `graph` series with
`layout: "none"`. This page records how, and why that code is Holotable's own.

## The decision

The layout is `graphLayout` in `src/lib/graph/layout.ts`: pure, about 500
lines with its comments, no dependency, and held by `test/graph.test.ts`
without a browser. It is the classic layered (Sugiyama) layout in four steps:

1. **Cycles.** A depth-first walk, from the roots in the order the rows named
   them, reverses each edge that points back up the walk. What remains is
   acyclic. A reversed edge keeps its real ends; the panel draws it against
   the flow, dashed and bowed out, so the loop is visible, and a click on it
   reports its real `source` and `target`.
2. **Layers.** The longest path from the roots, then each root pulled down to
   sit just above its nearest child, so a root that feeds only a deep node
   does not hang a long edge from the top row.
3. **Order.** An edge that spans several layers gets a placeholder in each
   layer it crosses. Each layer is then ordered by the barycenter of its
   neighbors, sweeping down and up, with a pass of neighbor swaps after each
   sweep, and the order with the fewest crossings is kept.
4. **Place.** Each node is pulled toward the mean of its neighbors in the
   next layer, sweeping down and up, keeping the layer's order and a gap
   between nodes: a least-squares fit solved exactly by pooling adjacent
   violators. Placeholders are pulled too, which straightens a long edge
   through the corridor the ordering gave it.

It is deterministic (no randomness; every tie falls to input order), so a
poll with the same rows draws the same picture, and the merged update moves
nothing.

The nodes sit on hidden value axes rather than ECharts' `view` coordinate
system. The `view` scales a symbol by the panel's width alone, so in a panel
whose shape differs from the layout's an icon is squashed. Pan and zoom are
the axes' inside zoom instead of `roam`: drag to pan, and pinch or Ctrl with
the wheel to zoom, so the wheel still scrolls the page past the panel.

### Refused alternatives

- **`dagre`** (`@dagrejs/dagre` 1.1.4, 96 KB minified, 29 KB gzipped, MIT).
  The layout most tools use, and the planned fallback. It did not draw the
  shapes below more readably (fewer crossings on one of three, more on two,
  and more edges through nodes on all three) and took 10 to 40 times as long.
  Taking it would add a dependency and a dynamic import for no gain a viewer
  could see.
- **`elkjs`.** Over 1 MB, for options (ports, orthogonal routing, nested
  graphs) a dashboard panel does not use.
- **ECharts' `force` layout** for these data. It reads as a cloud, not a flow,
  and left alone it moves on every update; it is the graph's `layout:
  "force"` ([#625](https://github.com/jbouder/holotable/issues/625)), for
  data with no direction, which settles once and starts each refresh from the
  positions it settled on rather than moving.

## What was measured

Four shapes, each laid out left to right by both. For Holotable, the drawing
is the layout's nodes with a straight line per edge; for dagre, its nodes and
the polyline it routes each edge along. **Crossings** counts pairs of drawn
edges that cross and share no end. **Through a node** counts edges that pass
within a quarter of a node gap of a node that is not one of their ends. Both
are in the same units (one between layers, one between nodes in a layer).
Times are the mean of 21 runs on Node 22, on an Apple-silicon laptop.

| Shape | Nodes, edges | Holotable: layers, crossings, through a node, time | dagre: layers, crossings, through a node, time |
| --- | --- | --- | --- |
| Holotable's own schema, foreign keys (dashboards and their versions point at each other) | 5, 5 | 4, 0, 0, 0.07 ms | 3, 0, 0, 0.75 ms |
| TPC-DS's foreign keys: seven fact tables over shared dimensions | 24, 79 | 5, 557, 44, 0.8 ms | 5, 583, 73, 9.6 ms |
| A 60-service call graph: edge, BFF, domain, platform and store tiers, two to four calls each, two calls back up | 60, 135 | 7, 656, 75, 0.7 ms | 7, 731, 120, 21.6 ms |
| A 200-node data lineage: raw, staging, intermediate, marts and reports, one to three inputs each, some skipping a tier | 199, 337 | 5, 3,500, 853, 2.0 ms | 5, 3,341, 1,179, 78.7 ms |

The service graph and the lineage are generated with a fixed seed. The
neighbor-swap pass was added after a first run without it left the service
graph at 723 crossings and the lineage at 3,722; it brought the two under or
within 5% of dagre's, at the cost of the TPC-DS schema rising from 512 to
557, still under dagre's 583. The cycle in the first shape is drawn as one
dashed edge; dagre reverses the same edge.

## Blocks

`node: "block"` ([#649](https://github.com/jbouder/holotable/issues/649))
draws each node as a box with its name inside, so a node is no longer a
point. The four steps stay as they are; `graphLayout` takes each node's size
(`LayoutSpacing`) and step 4 keeps a gap between two boxes' edges rather
than their centers (half the gap beside a placeholder, which is an edge
passing through), and each layer starts the layer gap past the widest box of
the one before. Without sizes every node is a point a unit from the next, and
the layout is exactly the one measured above. With them the coordinates are
pixels: the panel draws the plot a pixel a unit, in the middle of the panel,
spreads the centers (never the boxes) up to two and a half times as far
apart to fill it, and runs each edge from the middle of the side of its box
that faces the next layer to the middle of the side of the next box that
faces it, so an arrow meets a border. Since the boxes keep their size when
the plot zooms, a drawing of blocks has no zoom: it fits the panel whole, or
it is drawn as markers with a notice.

The tree and the force graph are ECharts' own layouts, so blocks there are a
question of fit rather than placement. ECharts' tree stretches its tidy-tree
units over the panel; `tidyTree` (`src/lib/graph/tidy-tree.ts`) computes the
same units (`test/graph.test.ts` holds it to ECharts' own on random trees),
and the boxes fit when each level is the widest boxes of it and the next
apart and any two of a level are their boxes and a gap apart at the nearest
ECharts would part them, which covers every branch a reader might close. The
force layout pushes nodes apart in every direction alike, so each box's
repulsion is in proportion to its half-diagonal, and the cloud at rest is
round: about 1.2 times the square root of the node count times the largest
box's diagonal and a gap across, as a simulation of ECharts' force step
found, which is what has to fit the panel's shorter side.

Re-measured with blocks (boxes 56 to 160 pixels wide by their names, 40
tall, gaps of 14 in a layer and 40 between layers), against the same
layouts as points. Ordering does not read sizes, so crossings are the same;
no two boxes overlap in any of them. **Through a box** counts edges whose
straight line passes inside a box that is not one of its ends, which a box
makes likelier than a point; the 60-service and 200-node shapes here are new
generations with a fixed seed, not those above.

| Shape | Nodes, edges | Layers | Crossings | Through a node, as points | Through a box, as blocks | Blocks' extent | Time, points / blocks |
| --- | --- | --- | --- | --- | --- | --- | --- |
| The demo's service map | 8, 8 | 3 | 0 | 0 | 0 | 356 × 202 px | 0.03 / 0.03 ms |
| The demo's network topology, top to bottom | 11, 16 | 5 | 0 | 2 | 2 | 374 × 360 px | 0.07 / 0.05 ms |
| A 60-service call graph, five tiers | 60, 149 | 10 | 658 | 75 | 157 | 1,302 × 811 px | 1.9 / 1.7 ms |
| A 200-node lineage, five tiers, some skipping one | 199, 329 | 5 | 2,876 | 779 | 1,074 | 596 × 3,389 px | 2.5 / 2.6 ms |

The two large shapes are what the prompt means by "large or dense": their
blocks do not fit a dashboard panel, so they are drawn as markers.

The next measurement worth making is on a graph people find unreadable. If
one turns up where dagre's drawing is clearly better, the swap is
`graphLayout`'s body: the panel, its tests of determinism and of reversed
edges, and the datum contract stay as they are.
