import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

/*
 * What a route's first load may not carry (#493). zod parses specs and
 * stored settings, and the AI SDK runs the chat; neither belongs on a page
 * that does not do those things. Both used to arrive through a client
 * component that needed one constant from a schema module.
 *
 * Walked from each route's entry files through server modules until a
 * "use client" boundary; from there every static runtime import counts. A
 * type-only import is erased, and an `import()` is a chunk of its own,
 * loaded when it runs, so neither does.
 */

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return spec; // a package
  for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const path = base + ext;
    if (existsSync(path) && statSync(path).isFile()) return path;
  }
  return null;
}

/** The static, runtime imports of a module: no `import type`, no `import()`. */
function runtimeImports(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    false,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: string[] = [];
  for (const node of source.statements) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause?.isTypeOnly) continue;
      const named = clause?.namedBindings;
      const onlyTypes =
        clause !== undefined &&
        clause.name === undefined &&
        named !== undefined &&
        ts.isNamedImports(named) &&
        named.elements.length > 0 &&
        named.elements.every((e) => e.isTypeOnly);
      if (onlyTypes) continue;
      out.push((node.moduleSpecifier as ts.StringLiteral).text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (node.isTypeOnly) continue;
      const clause = node.exportClause;
      if (
        clause &&
        ts.isNamedExports(clause) &&
        clause.elements.every((e) => e.isTypeOnly)
      ) {
        continue;
      }
      out.push((node.moduleSpecifier as ts.StringLiteral).text);
    }
  }
  return out;
}

const isClient = (file: string) =>
  /^\s*["']use client["']/.test(readFileSync(file, "utf8"));

/**
 * For every package matching `banned`, one chain of runtime imports from an
 * entry, through a client boundary, to it. Empty when the route is clean.
 */
function clientChains(entries: string[], banned: RegExp): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const queue = entries.map((e) => ({ file: join(ROOT, e), path: [e], client: false }));
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    const client = item.client || isClient(item.file);
    const key = `${item.file}:${client}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const spec of runtimeImports(item.file)) {
      const target = resolveImport(item.file, spec);
      if (target === null) continue;
      if (!target.startsWith(SRC)) {
        if (client && banned.test(spec)) found.push([...item.path, spec].join(" -> "));
        continue;
      }
      queue.push({ file: target, path: [...item.path, relative(ROOT, target)], client });
    }
  }
  return found;
}

const ROOT_LAYOUT = ["src/app/layout.tsx", "src/app/template.tsx"];

test("the start page, the dashboard list and settings load no zod", () => {
  for (const [route, entries] of Object.entries({
    "/": [...ROOT_LAYOUT, "src/app/page.tsx"],
    "/dashboards": [...ROOT_LAYOUT, "src/app/dashboards/page.tsx"],
    "/settings": [
      ...ROOT_LAYOUT,
      "src/app/settings/layout.tsx",
      "src/app/settings/page.tsx",
    ],
  })) {
    assert.deepEqual(clientChains(entries, /^zod(\/|$)/), [], `zod on ${route}`);
  }
});

test("a dashboard view loads no AI SDK until its chat is opened", () => {
  const chains = clientChains(
    [...ROOT_LAYOUT, "src/app/dashboards/[id]/page.tsx"],
    /^(ai|@ai-sdk\/.*|swr)$/,
  );
  assert.deepEqual(chains, []);
});

test("ECharts loads with the first chart, not with the dashboard or the embed", () => {
  // #497: a dashboard of stats or text, or an embed of one, never needs it;
  // `PanelView` loads the chart with `React.lazy`, which is a chunk of its own.
  for (const [route, entries] of Object.entries({
    "/dashboards/[id]": [...ROOT_LAYOUT, "src/app/dashboards/[id]/page.tsx"],
    "/embed/dashboards/[id]": [...ROOT_LAYOUT, "src/app/embed/dashboards/[id]/page.tsx"],
  })) {
    assert.deepEqual(clientChains(entries, /^echarts(\/|$)/), [], `ECharts on ${route}`);
  }
});
