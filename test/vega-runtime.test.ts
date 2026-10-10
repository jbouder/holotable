import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import {
  createVegaView,
  loadVega,
  refusingLoader,
  replaceVegaRows,
  VEGA_DATASET,
} from "@/components/charts/vega-runtime";
import { compileVegaLite } from "@/lib/vega/compile";

/*
 * The custom-visual runtime (#405, phase 1): what the spike found, held. Vega
 * runs with no function built from a string (the production CSP has no
 * 'unsafe-eval'), reaches nothing over the network, and takes new rows as a
 * changeset into the same view.
 */

const ROWS = Array.from({ length: 120 }, (_, i) => ({
  t: new Date(Date.UTC(2026, 9, 9, 10, i)).toISOString(),
  p5: 20 + (i % 7),
  p50: 80 + (i % 13),
  p95: 300 + (i % 29),
  host: `h${i % 4}`,
}));

/** A band, a line per host with a tooltip, a rule, and two expressions. */
const BAND = {
  data: { name: "rows" },
  transform: [
    { calculate: "datum.p95 - datum.p5", as: "spread" },
    { filter: "datum.p50 > 0 && isValid(datum.host)" },
  ],
  layer: [
    {
      mark: "area",
      encoding: {
        x: { field: "t", type: "temporal" },
        y: { field: "p5", type: "quantitative" },
        y2: { field: "p95" },
        opacity: { value: 0.25 },
      },
    },
    {
      mark: { type: "line", tooltip: true },
      encoding: {
        x: { field: "t", type: "temporal" },
        y: { field: "p50", type: "quantitative" },
        color: { field: "host" },
      },
    },
    { mark: "rule", encoding: { y: { datum: 500 } } },
  ],
};

async function compiled(spec: unknown) {
  const result = await compileVegaLite(spec);
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result.spec;
}

/** Runs `body` with `Function` made to throw, as the CSP makes it in the browser. */
async function withoutEval<T>(
  body: () => Promise<T>,
): Promise<{ value: T; calls: number }> {
  const real = globalThis.Function;
  let calls = 0;
  globalThis.Function = new Proxy(real, {
    construct() {
      calls++;
      throw new EvalError("blocked: no 'unsafe-eval'");
    },
    apply() {
      calls++;
      throw new EvalError("blocked: no 'unsafe-eval'");
    },
  });
  try {
    return { value: await body(), calls };
  } finally {
    globalThis.Function = real;
  }
}

test("a spec compiles on the server; a broken one says why", async () => {
  const ok = await compileVegaLite(BAND);
  assert.equal(ok.ok, true);
  const bad = await compileVegaLite({
    data: { name: "rows" },
    mark: "bar",
    encoding: { x: { field: "a", type: "nope" } },
  });
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.error, /field type/i);
  // An unknown mark is refused too, though Vega-Lite's own message for it is
  // poor: phase 2 checks names like it before compiling.
  assert.equal(
    (await compileVegaLite({ data: { name: "rows" }, mark: "nope" })).ok,
    false,
  );
  assert.equal((await compileVegaLite("mark: bar")).ok, false);
  assert.equal((await compileVegaLite([])).ok, false);
});

test("the view runs, expressions and all, with no function built from a string", async () => {
  const spec = await compiled(BAND);
  const { value: svg, calls } = await withoutEval(async () => {
    const view = await createVegaView(spec, ROWS, { renderer: "none" });
    return view.toSVG();
  });
  assert.equal(calls, 0);
  assert.match(svg, /<path/);
});

test("the guard is real: Vega's default expression compiler is what the CSP would block", async () => {
  // Without the interpreter, Vega compiles expressions with Function: this is
  // why the runtime parses to an AST and interprets it.
  const { parse, View } = (await loadVega()).vega;
  const spec = await compiled(BAND);
  const { calls } = await withoutEval(async () => {
    try {
      const view = new View(parse(spec), { renderer: "none" });
      view.data(VEGA_DATASET, ROWS);
      await view.runAsync();
    } catch {
      // Blocked, as expected.
    }
  });
  assert.ok(calls > 0);
});

test("the loader refuses every URL, file and data URI", async () => {
  const loader = refusingLoader((await loadVega()).vega);
  for (const uri of [
    "https://example.com/data.json",
    "http://169.254.169.254/latest/meta-data",
    "file:///etc/passwd",
    "data:application/json,[1]",
    "/api/me",
  ]) {
    await assert.rejects(loader.load(uri), /cannot load/, uri);
    await assert.rejects(loader.sanitize(uri, { context: "href" }), /cannot load/, uri);
  }
});

test("a spec that names a URL draws without fetching it", async () => {
  const spec = await compiled({
    data: { url: "https://example.com/x.json" },
    mark: "point",
    encoding: { x: { field: "a", type: "quantitative" } },
  });
  const view = await createVegaView(spec, [], { renderer: "none" });
  assert.deepEqual(view.data("source_0"), []);
});

test("new rows are a changeset into the same view, not a new one", async () => {
  const view = await createVegaView(await compiled(BAND), ROWS, { renderer: "none" });
  assert.equal(view.data(VEGA_DATASET).length, ROWS.length);
  await replaceVegaRows(view, ROWS.slice(0, 10));
  assert.equal(view.data(VEGA_DATASET).length, 10);
  assert.match(await view.toSVG(), /<path/);
});

test("only the runtime and the compiler import Vega, so it loads with a custom visual alone", () => {
  const root = join(import.meta.dirname, "..", "src");
  const allowed = new Set(["components/charts/vega-runtime.ts", "lib/vega/compile.ts"]);
  const importers: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name)) {
        const text = readFileSync(path, "utf8");
        // A type-only import is erased from the bundle; anything else is not.
        const runtime = text.replace(/^import type [^;]+;$/gm, "");
        if (/from "vega(-lite|-interpreter)?"|import\("vega/.test(runtime)) {
          importers.push(relative(root, path));
        }
      }
    }
  };
  walk(root);
  assert.deepEqual(
    importers.filter((f) => !allowed.has(f)),
    [],
  );
});
