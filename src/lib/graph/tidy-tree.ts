/**
 * Where ECharts' `tree` series puts each node across the tree (#649), in its
 * own units, before it scales them to the panel: the Reingold–Tilford tidy
 * tree as ECharts' `layoutHelper` runs it (Walker's linear version, with
 * Buchheim's fix), siblings a unit apart and any other neighbors two, or on
 * a radial tree that over the node's depth.
 *
 * ECharts spaces a tree only by stretching these units to fill the panel, so
 * whether a graph's blocks fit a tree is a question of how close the closest
 * two nodes of a level are here. Pure and deterministic, like the layout it
 * mirrors; `test/graph.test.ts` holds it to ECharts' own positions.
 */

export interface TidyInput {
  children: readonly TidyInput[];
}

export interface TidyPlace<T extends TidyInput> {
  node: T;
  /** Across the tree, in units: siblings one apart, other neighbors two. */
  x: number;
  /** From 1 at the root, as ECharts counts it. */
  depth: number;
}

interface Hier<T extends TidyInput> {
  node: T;
  parent: Hier<T> | null;
  children: Hier<T>[];
  depth: number;
  i: number;
  prelim: number;
  modifier: number;
  change: number;
  shift: number;
  ancestor: Hier<T>;
  thread: Hier<T> | null;
  defaultAncestor: Hier<T> | null;
  x: number;
}

/** ECharts' separation: siblings a unit apart, anything else two; radially, over the depth. */
function separation<T extends TidyInput>(radial: boolean) {
  return (a: Hier<T>, b: Hier<T>) =>
    (a.parent === b.parent ? 1 : 2) / (radial ? a.depth : 1);
}

/**
 * Every node of the tree under `root` with its place, parents first, and
 * the extent ECharts scales over: from the leftmost node less half a
 * separation to the rightmost plus one (a unit, for one node alone).
 */
export function tidyTree<T extends TidyInput>(
  root: T,
  radial = false,
): { places: TidyPlace<T>[]; span: number } {
  const sep = separation<T>(radial);
  // ECharts hangs the root under a virtual one, at depth 0.
  const make = (node: T, parent: Hier<T> | null, depth: number, i: number): Hier<T> => {
    const h = {
      node,
      parent,
      children: [],
      depth,
      i,
      prelim: 0,
      modifier: 0,
      change: 0,
      shift: 0,
      thread: null,
      defaultAncestor: null,
      x: 0,
    } as unknown as Hier<T>;
    h.ancestor = h;
    h.children = node.children.map((c, j) => make(c as T, h, depth + 1, j));
    return h;
  };
  const virtual = make({ children: [root] } as unknown as T, null, 0, 0);
  const real = virtual.children[0] as Hier<T>;

  const nextRight = (v: Hier<T>) =>
    v.children.length ? (v.children[v.children.length - 1] as Hier<T>) : v.thread;
  const nextLeft = (v: Hier<T>) =>
    v.children.length ? (v.children[0] as Hier<T>) : v.thread;
  const nextAncestor = (vil: Hier<T>, v: Hier<T>, ancestor: Hier<T>) =>
    vil.ancestor.parent === v.parent ? vil.ancestor : ancestor;
  const moveSubtree = (wl: Hier<T>, wr: Hier<T>, shift: number) => {
    const change = shift / (wr.i - wl.i);
    wr.change -= change;
    wr.shift += shift;
    wr.modifier += shift;
    wr.prelim += shift;
    wl.change += change;
  };
  const executeShifts = (v: Hier<T>) => {
    let shift = 0;
    let change = 0;
    for (let n = v.children.length - 1; n >= 0; n--) {
      const c = v.children[n] as Hier<T>;
      c.prelim += shift;
      c.modifier += shift;
      change += c.change;
      shift += c.shift + change;
    }
  };
  const apportion = (v: Hier<T>, w: Hier<T> | null, ancestor: Hier<T>): Hier<T> => {
    if (!w) return ancestor;
    let vor = v;
    let vir: Hier<T> | null = v;
    let vol = (v.parent as Hier<T>).children[0] as Hier<T>;
    let vil: Hier<T> | null = w;
    let sor = vor.modifier;
    let sir = vir.modifier;
    let sol = vol.modifier;
    let sil = vil.modifier;
    for (;;) {
      vil = nextRight(vil);
      vir = nextLeft(vir);
      if (!vil || !vir) break;
      vor = nextRight(vor) as Hier<T>;
      vol = nextLeft(vol) as Hier<T>;
      vor.ancestor = v;
      const shift = vil.prelim + sil - vir.prelim - sir + sep(vil, vir);
      if (shift > 0) {
        moveSubtree(nextAncestor(vil, v, ancestor), v, shift);
        sir += shift;
        sor += shift;
      }
      sil += vil.modifier;
      sir += vir.modifier;
      sor += vor.modifier;
      sol += vol.modifier;
    }
    if (vil && !nextRight(vor)) {
      vor.thread = vil;
      vor.modifier += sil - sor;
    }
    if (vir && !nextLeft(vol)) {
      vol.thread = vir;
      vol.modifier += sir - sol;
      return v;
    }
    return ancestor;
  };
  const firstWalk = (v: Hier<T>) => {
    const siblings = (v.parent as Hier<T>).children;
    const w = v.i ? (siblings[v.i - 1] as Hier<T>) : null;
    if (v.children.length) {
      executeShifts(v);
      const mid =
        ((v.children[0] as Hier<T>).prelim +
          (v.children[v.children.length - 1] as Hier<T>).prelim) /
        2;
      if (w) {
        v.prelim = w.prelim + sep(v, w);
        v.modifier = v.prelim - mid;
      } else v.prelim = mid;
    } else if (w) {
      v.prelim = w.prelim + sep(v, w);
    }
    const parent = v.parent as Hier<T>;
    parent.defaultAncestor = apportion(
      v,
      w,
      parent.defaultAncestor ?? (siblings[0] as Hier<T>),
    );
  };
  // After: children before their parent, in order.
  const after = (v: Hier<T>) => {
    for (const c of v.children) after(c);
    firstWalk(v);
  };
  after(real);
  virtual.modifier = -real.prelim;
  const places: TidyPlace<T>[] = [];
  const before = (v: Hier<T>) => {
    const parent = v.parent as Hier<T>;
    v.x = v.prelim + parent.modifier;
    v.modifier += parent.modifier;
    places.push({ node: v.node, x: v.x, depth: v.depth });
    for (const c of v.children) before(c);
  };
  before(real);

  let left = real;
  let right = real;
  const all: Hier<T>[] = [];
  const collect = (v: Hier<T>) => {
    all.push(v);
    v.children.forEach(collect);
  };
  collect(real);
  for (const v of all) {
    if (v.x < left.x) left = v;
    if (v.x > right.x) right = v;
  }
  const delta = left === right ? 1 : sep(left, right) / 2;
  const tx = delta - left.x;
  for (const p of places) p.x += tx;
  return { places, span: right.x + delta + tx };
}
