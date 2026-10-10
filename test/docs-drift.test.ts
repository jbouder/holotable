import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { AUDIT_ACTIONS } from "@/lib/audit";
import { SETTINGS_SECTIONS } from "@/lib/settings";

/*
 * Hand-maintained lists in the docs that have a source of truth in code
 * (#144). The configuration and visualization references are generated and
 * cannot drift; these three are prose tables, so a test holds each to the
 * code it describes instead.
 */

const DOCS = "docs/src/content/docs";
const read = (path: string) => readFileSync(path, "utf8");

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return name === "route.ts" ? [path] : [];
  });
}

/** `/api/x/[id]` → the set of methods its route file exports. */
function codeRoutes(): Map<string, Set<string>> {
  const routes = new Map<string, Set<string>>();
  for (const file of routeFiles("src/app/api")) {
    const path = `/${relative("src/app", file).replace(/\/route\.ts$/, "")}`;
    const methods = [
      ...read(file).matchAll(
        /^export (?:const|async function|function) (GET|POST|PUT|PATCH|DELETE)\b/gm,
      ),
    ].map((m) => m[1]);
    routes.set(path, new Set(methods));
  }
  return routes;
}

/** Every table row on the API routes page that starts with a route. */
function documentedRoutes(): Map<string, Set<string>> {
  const routes = new Map<string, Set<string>>();
  for (const line of read(`${DOCS}/reference/api-routes.md`).split("\n")) {
    const m = line.match(/^\| `(\/api\/[^`]+)` \| ([^|]+) \|/);
    if (!m) continue;
    const methods = m[2].match(/\b(GET|POST|PUT|PATCH|DELETE)\b/g) ?? [];
    const known = routes.get(m[1]) ?? new Set<string>();
    for (const method of methods) known.add(method);
    routes.set(m[1], known);
  }
  return routes;
}

test("every API route and method has a row on the API routes page, and every row exists", () => {
  const code = codeRoutes();
  const docs = documentedRoutes();
  assert.ok(code.size > 30, "found the route files");

  const undocumented = [...code].flatMap(([path, methods]) =>
    [...methods].filter((m) => !docs.get(path)?.has(m)).map((m) => `${m} ${path}`),
  );
  const stale = [...docs].flatMap(([path, methods]) =>
    [...methods].filter((m) => !code.get(path)?.has(m)).map((m) => `${m} ${path}`),
  );
  assert.deepEqual(
    undocumented,
    [],
    "add these to docs/src/content/docs/reference/api-routes.md",
  );
  assert.deepEqual(stale, [], "these rows name a route or method that no longer exists");
});

test("every audit action is described on the audit log page", () => {
  const page = read(`${DOCS}/operations/audit-log.md`);
  const missing = AUDIT_ACTIONS.filter((action) => !page.includes(`\`${action}\``));
  assert.deepEqual(
    missing,
    [],
    "add these to docs/src/content/docs/operations/audit-log.md",
  );
});

test("every settings section is listed on the settings page", () => {
  const page = read(`${DOCS}/guide/settings.md`);
  const missing = SETTINGS_SECTIONS.filter(
    (section) => !page.includes(`| \`${section.href}\` |`),
  ).map((section) => section.href);
  assert.deepEqual(
    missing,
    [],
    "add these to the table in docs/src/content/docs/guide/settings.md",
  );
});
