import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

/*
 * ECharts is loaded in one place (#488): `src/components/charts/echarts.ts`
 * registers only the series and components the panels draw, on
 * `echarts/core`. A runtime import of `echarts` anywhere else would put the
 * whole library back in the bundle. Type imports are erased, so they may stay.
 */
test("only the chart module imports ECharts at runtime", () => {
  const root = join(import.meta.dirname, "..", "src");
  const importers: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name)) {
        const runtime = readFileSync(path, "utf8").replace(/^import type [^;]+;$/gm, "");
        if (/from "echarts(\/[^"]*)?"|import\("echarts/.test(runtime)) {
          importers.push(relative(root, path));
        }
      }
    }
  };
  walk(root);
  assert.deepEqual(importers, ["components/charts/echarts.ts"]);
  // And it is the core, never the full build.
  const module = readFileSync(join(root, "components/charts/echarts.ts"), "utf8");
  assert.doesNotMatch(module, /from "echarts";/);
});
