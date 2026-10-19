/**
 * A layered layout for a directed graph (#624): the `dag` layout of the graph
 * panel kind, owned rather than taken from `dagre` or `elkjs` (the measurement
 * is on `docs/src/content/docs/architecture/graph-layout.md`).
 *
 * The classic four steps, each small and pure:
 *
 * 1. **Cycles.** A depth-first pass, roots first and in the order the nodes
 *    came, reverses every edge that points back up the walk. What is left is
 *    acyclic; a reversed edge keeps its real ends and says it was reversed,
 *    so it is drawn against the flow and marked.
 * 2. **Layers.** Longest path from the roots, then each root pulled down to
 *    sit just above its nearest child, so a root that feeds only a deep node
 *    does not hang a long edge from the top.
 * 3. **Order.** An edge across several layers gets a placeholder in each
 *    layer it crosses, then each layer is ordered by the barycenter of its
 *    neighbors, sweeping down and up, keeping the order with the fewest
 *    crossings.
 * 4. **Place.** Each node is pulled toward the mean of its neighbors in the
 *    next layer, sweeping down and up, keeping the layer's order and a gap
 *    between nodes (an isotonic fit, so exact and linear). Placeholders are
 *    pulled too, which straightens a long edge through the corridor it was
 *    given; ECharts draws it from end to end.
 *
 * Deterministic: no randomness, and every tie falls to input order.
 * Coordinates are in units (one between layers, one between nodes); ECharts
 * fits them to the panel.
 */

/** Which way the layers run: left to right, or top to bottom. */
export type GraphDirection = "LR" | "TB";

export interface LayoutEdge {
  source: string;
  target: string;
}

export interface PlacedNode {
  id: string;
  x: number;
  y: number;
  /** Its layer, from 0 at the roots. */
  layer: number;
  /** Its place in the layer, from 0. */
  order: number;
}

export interface PlacedEdge extends LayoutEdge {
  /** Drawn against the flow: the edge a cycle was broken at. */
  reversed: boolean;
}

export interface GraphLayout {
  /** Every node, in the order given. */
  nodes: PlacedNode[];
  /** Every edge between two known nodes, once, in the order given; no self-edges. */
  edges: PlacedEdge[];
  /** How many edges were reversed to break cycles. */
  reversed: number;
  /** How many layers. */
  layers: number;
  /** Crossings between adjacent layers in the order kept, placeholders included. */
  crossings: number;
}

/** Barycenter sweeps at most, down and up alternately. */
const ORDER_SWEEPS = 24;
/** Sweeps without a better order before giving up early. */
const ORDER_PATIENCE = 4;
/** Placement sweeps, down and up alternately. */
const PLACE_SWEEPS = 8;
/** The least gap between two nodes in a layer, and beside a placeholder. */
const NODE_GAP = 1;
const DUMMY_GAP = 0.5;

/** The nodes laid out in layers, `direction` the way the layers run. */
export function graphLayout(
  nodeIds: readonly string[],
  edgeList: readonly LayoutEdge[],
  direction: GraphDirection = "LR",
): GraphLayout {
  const index = new Map<string, number>();
  for (const id of nodeIds) if (!index.has(id)) index.set(id, index.size);
  const ids = [...index.keys()];
  const n = ids.length;

  // The edges once each, between known nodes, with no self-edge.
  const seen = new Set<string>();
  const edges: [number, number][] = [];
  for (const e of edgeList) {
    const s = index.get(e.source);
    const t = index.get(e.target);
    if (s === undefined || t === undefined || s === t) continue;
    const key = `${s}>${t}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push([s, t]);
  }

  const reversed = breakCycles(n, edges);
  // The acyclic edges, flipped where reversed, once each.
  const flowSeen = new Set<string>();
  const flow: [number, number][] = [];
  edges.forEach(([s, t], i) => {
    const [a, b] = reversed[i] ? [t, s] : [s, t];
    const key = `${a}>${b}`;
    if (flowSeen.has(key)) return;
    flowSeen.add(key);
    flow.push([a, b]);
  });

  const layer = assignLayers(n, flow);
  const layerCount = n === 0 ? 0 : Math.max(...layer) + 1;

  // Placeholders: one per layer an edge crosses, chained from end to end.
  const layerOf = [...layer];
  const up: number[][] = Array.from({ length: n }, () => []);
  const down: number[][] = Array.from({ length: n }, () => []);
  const link = (a: number, b: number) => {
    down[a]?.push(b);
    up[b]?.push(a);
  };
  let count = n;
  for (const [a, b] of flow) {
    let from = a;
    for (let l = (layer[a] as number) + 1; l < (layer[b] as number); l++) {
      const dummy = count++;
      layerOf.push(l);
      up.push([]);
      down.push([]);
      link(from, dummy);
      from = dummy;
    }
    link(from, b);
  }

  const ordered = orderLayers(layerOf, layerCount, up, down, count);
  const cross = placeCross(ordered.layers, n, up, down);

  const nodes: PlacedNode[] = ids.map((id, i) => {
    const l = layer[i] as number;
    const c = cross[i] as number;
    return {
      id,
      layer: l,
      order: ordered.position[i] as number,
      ...(direction === "LR" ? { x: l, y: c } : { x: c, y: l }),
    };
  });
  return {
    nodes,
    edges: edges.map(([s, t], i) => ({
      source: ids[s] as string,
      target: ids[t] as string,
      reversed: reversed[i] as boolean,
    })),
    reversed: reversed.filter(Boolean).length,
    layers: layerCount,
    crossings: ordered.crossings,
  };
}

/**
 * Which edges to reverse so none points back up a depth-first walk: started
 * from each root in order, then from any node no root reached (a cycle with
 * nothing above it), children in the order their edges came.
 */
function breakCycles(n: number, edges: [number, number][]): boolean[] {
  const out: number[][] = Array.from({ length: n }, () => []);
  const indegree = new Array<number>(n).fill(0);
  edges.forEach(([s, t], i) => {
    out[s]?.push(i);
    indegree[t] = (indegree[t] as number) + 1;
  });
  const reversed = new Array<boolean>(edges.length).fill(false);
  // 0 unvisited, 1 on the walk, 2 done.
  const state = new Array<number>(n).fill(0);
  const walk = (start: number) => {
    if (state[start] !== 0) return;
    const stack: [number, number][] = [[start, 0]];
    state[start] = 1;
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as [number, number];
      const [v, next] = top;
      const edgesOut = out[v] as number[];
      if (next >= edgesOut.length) {
        state[v] = 2;
        stack.pop();
        continue;
      }
      top[1] = next + 1;
      const e = edgesOut[next] as number;
      const t = (edges[e] as [number, number])[1];
      if (state[t] === 1) reversed[e] = true;
      else if (state[t] === 0) {
        state[t] = 1;
        stack.push([t, 0]);
      }
    }
  };
  for (let v = 0; v < n; v++) if (indegree[v] === 0) walk(v);
  for (let v = 0; v < n; v++) walk(v);
  return reversed;
}

/** Longest path from the roots, then each root just above its nearest child. */
function assignLayers(n: number, flow: [number, number][]): number[] {
  const out: number[][] = Array.from({ length: n }, () => []);
  const indegree = new Array<number>(n).fill(0);
  for (const [a, b] of flow) {
    out[a]?.push(b);
    indegree[b] = (indegree[b] as number) + 1;
  }
  const layer = new Array<number>(n).fill(0);
  const remaining = [...indegree];
  const queue: number[] = [];
  for (let v = 0; v < n; v++) if (indegree[v] === 0) queue.push(v);
  for (let i = 0; i < queue.length; i++) {
    const v = queue[i] as number;
    for (const w of out[v] as number[]) {
      layer[w] = Math.max(layer[w] as number, (layer[v] as number) + 1);
      remaining[w] = (remaining[w] as number) - 1;
      if (remaining[w] === 0) queue.push(w);
    }
  }
  for (let v = 0; v < n; v++) {
    const children = out[v] as number[];
    if (indegree[v] === 0 && children.length > 0) {
      layer[v] = Math.min(...children.map((w) => layer[w] as number)) - 1;
    }
  }
  return layer;
}

/**
 * Each layer's order by barycenter sweeps, the one with fewest crossings
 * kept. A node with no neighbor in the layer it is ordered against keeps its
 * place; ties keep the order they had.
 */
function orderLayers(
  layerOf: number[],
  layerCount: number,
  up: number[][],
  down: number[][],
  count: number,
): { layers: number[][]; position: number[]; crossings: number } {
  const layers: number[][] = Array.from({ length: layerCount }, () => []);
  for (let v = 0; v < count; v++) layers[layerOf[v] as number]?.push(v);
  const position = new Array<number>(count).fill(0);
  const renumber = (row: number[]) =>
    row.forEach((v, i) => {
      position[v] = i;
    });
  for (const row of layers) renumber(row);

  const sweep = (l: number, neighbors: number[][]) => {
    const row = layers[l] as number[];
    const key = new Map<number, number>();
    for (const v of row) {
      const ns = neighbors[v] as number[];
      key.set(
        v,
        ns.length === 0
          ? (position[v] as number)
          : ns.reduce((sum, w) => sum + (position[w] as number), 0) / ns.length,
      );
    }
    row.sort(
      (a, b) =>
        (key.get(a) as number) - (key.get(b) as number) ||
        (position[a] as number) - (position[b] as number),
    );
    renumber(row);
  };

  let best = layers.map((row) => [...row]);
  let bestCrossings = totalCrossings(layers, down, position);
  let stale = 0;
  for (let s = 0; s < ORDER_SWEEPS && bestCrossings > 0 && stale < ORDER_PATIENCE; s++) {
    if (s % 2 === 0) for (let l = 1; l < layerCount; l++) sweep(l, up);
    else for (let l = layerCount - 2; l >= 0; l--) sweep(l, down);
    transpose(layers, up, down, position, renumber);
    const crossings = totalCrossings(layers, down, position);
    if (crossings < bestCrossings) {
      best = layers.map((row) => [...row]);
      bestCrossings = crossings;
      stale = 0;
    } else stale++;
  }
  for (const row of best) renumber(row);
  return { layers: best, position, crossings: bestCrossings };
}

/**
 * Swap neighbors in a layer while that crosses fewer edges, against the
 * layers above and below: what the barycenter misses between near ties.
 */
function transpose(
  layers: number[][],
  up: number[][],
  down: number[][],
  position: number[],
  renumber: (row: number[]) => void,
) {
  // Crossings of u's edges with v's on one side, u placed before v.
  const pairCross = (u: number, v: number, neighbors: number[][]) => {
    let c = 0;
    for (const a of neighbors[u] as number[]) {
      for (const b of neighbors[v] as number[]) {
        if ((position[a] as number) > (position[b] as number)) c++;
      }
    }
    return c;
  };
  const cost = (u: number, v: number) => pairCross(u, v, up) + pairCross(u, v, down);
  for (let pass = 0, improved = true; improved && pass < 4; pass++) {
    improved = false;
    for (const row of layers) {
      for (let i = 0; i + 1 < row.length; i++) {
        const u = row[i] as number;
        const v = row[i + 1] as number;
        if (cost(v, u) < cost(u, v)) {
          row[i] = v;
          row[i + 1] = u;
          renumber(row);
          improved = true;
        }
      }
    }
  }
}

/** Crossings between every pair of adjacent layers, by counting inversions. */
function totalCrossings(
  layers: number[][],
  down: number[][],
  position: number[],
): number {
  let total = 0;
  for (let l = 0; l + 1 < layers.length; l++) {
    const pairs: [number, number][] = [];
    for (const v of layers[l] as number[]) {
      for (const w of down[v] as number[]) {
        pairs.push([position[v] as number, position[w] as number]);
      }
    }
    pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    total += inversions(pairs.map((p) => p[1]));
  }
  return total;
}

/** Pairs out of order, by a merge sort: the edges that cross. */
function inversions(values: number[]): number {
  if (values.length < 2) return 0;
  const mid = values.length >> 1;
  const left = values.slice(0, mid);
  const right = values.slice(mid);
  let count = inversions(left) + inversions(right);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < left.length && j < right.length) {
    if ((left[i] as number) <= (right[j] as number)) values[k++] = left[i++] as number;
    else {
      values[k++] = right[j++] as number;
      count += left.length - i;
    }
  }
  while (i < left.length) values[k++] = left[i++] as number;
  while (j < right.length) values[k++] = right[j++] as number;
  return count;
}

/**
 * Each node's place across its layer: pulled toward its neighbors' mean,
 * sweeping down and up, the layer's order and gaps kept. Returns the real
 * nodes' places, the least of them 0.
 */
function placeCross(layers: number[][], n: number, up: number[][], down: number[][]) {
  const total = up.length;
  const cross = new Array<number>(total).fill(0);
  const gap = (a: number, b: number) => (a < n && b < n ? NODE_GAP : DUMMY_GAP);
  for (const row of layers) {
    let at = 0;
    row.forEach((v, i) => {
      if (i > 0) at += gap(row[i - 1] as number, v);
      cross[v] = at;
    });
    const mid = at / 2;
    for (const v of row) cross[v] = (cross[v] as number) - mid;
  }
  const settle = (row: number[], neighbors: number[][]) => {
    const want = row.map((v) => {
      const ns = neighbors[v] as number[];
      return ns.length === 0
        ? (cross[v] as number)
        : ns.reduce((sum, w) => sum + (cross[w] as number), 0) / ns.length;
    });
    const gaps = row.map((v, i) => (i === 0 ? 0 : gap(row[i - 1] as number, v)));
    fitInOrder(want, gaps).forEach((c, i) => {
      cross[row[i] as number] = c;
    });
  };
  for (let s = 0; s < PLACE_SWEEPS; s++) {
    if (s % 2 === 0)
      for (let l = 1; l < layers.length; l++) settle(layers[l] as number[], up);
    else for (let l = layers.length - 2; l >= 0; l--) settle(layers[l] as number[], down);
  }
  const real = cross.slice(0, n);
  const least = real.length === 0 ? 0 : Math.min(...real);
  return real.map((c) => c - least);
}

/**
 * The places closest to `want` (least squares) that keep their order with at
 * least `gaps[i]` before the i-th: pool adjacent violators, on the places
 * less their running gap.
 */
function fitInOrder(want: number[], gaps: number[]): number[] {
  const offset: number[] = [];
  let run = 0;
  for (let i = 0; i < want.length; i++) {
    run += gaps[i] as number;
    offset.push(run);
  }
  const blocks: { sum: number; size: number; start: number }[] = [];
  for (let i = 0; i < want.length; i++) {
    blocks.push({ sum: (want[i] as number) - (offset[i] as number), size: 1, start: i });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1] as { sum: number; size: number };
      const prev = blocks[blocks.length - 2] as { sum: number; size: number };
      if (prev.sum / prev.size <= last.sum / last.size) break;
      prev.sum += last.sum;
      prev.size += last.size;
      blocks.pop();
    }
  }
  const out = new Array<number>(want.length);
  for (const b of blocks) {
    for (let i = b.start; i < b.start + b.size; i++)
      out[i] = b.sum / b.size + (offset[i] as number);
  }
  return out;
}
