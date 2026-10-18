import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SPEC_VERSION } from "@/lib/ir";

/**
 * The quick-start image's out-of-the-box journey (#600), over HTTP, the way a
 * browser takes it: `docker run` with no flags signs the visitor in as the
 * local owner, who may add a source, so the sample CSV the app ships uploads,
 * becomes a DuckDB source, and a dashboard over it answers with rows.
 *
 * Run inside the container, against the server it supervises:
 *
 *   docker exec <container> node node_modules/.bin/tsx scripts/smoke-quickstart.ts
 *
 * CI's "Images and smoke" job runs it after `npm run smoke` against the same
 * container. Nothing here is special to the image but where it runs; every
 * step goes through the same routes the data-sources page and the dashboard
 * use.
 */

const base = (
  process.env.SMOKE_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`
).replace(/\/$/, "");
const SAMPLE = join(process.cwd(), "public/samples/household-expenses.csv");

function fail(message: string): never {
  console.error(`smoke-quickstart: FAILED: ${message}`);
  process.exit(1);
}

/** Enter the way the proxy sends a browser: the login route, no credentials. */
async function enter(): Promise<string> {
  const res = await fetch(`${base}/api/auth/login?next=/`, { redirect: "manual" });
  const cookie = res.headers
    .getSetCookie()
    .find((c) => /^(__Host-)?holotable_session=/.test(c));
  if (res.status !== 302 || !cookie) {
    fail(`sign-in answered ${res.status} without a session cookie`);
  }
  return cookie.split(";")[0];
}

async function call<T>(path: string, cookie: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie },
  });
  if (!res.ok) {
    fail(`${init.method ?? "GET"} ${path} answered ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

const postJson = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

interface Me {
  sub: string;
  platformAdmin: boolean;
  workspaces: { id: string; role: string }[];
}

async function main(): Promise<void> {
  const cookie = await enter();
  const me = await call<Me>("/api/me", cookie);
  if (me.sub !== "local:owner") fail(`signed in as ${me.sub}, not local:owner`);
  if (me.platformAdmin) fail("the local owner is a platform admin");
  const workspace = me.workspaces.find((w) => w.role === "source-admin")?.id;
  if (!workspace) fail(`no source-admin workspace in ${JSON.stringify(me.workspaces)}`);
  // One identity: a second visitor without a cookie is the same owner.
  const again = await call<Me>("/api/me", await enter());
  if (again.sub !== me.sub) fail(`a second sign-in named ${again.sub}`);
  console.log(`smoke-quickstart: signed in as ${me.sub}, source-admin of "${workspace}"`);

  // No MCP clients without a realm.
  const mcp = await fetch(`${base}/api/mcp`, { method: "POST" });
  if (mcp.status !== 404) fail(`/api/mcp answered ${mcp.status}, not 404`);

  const form = new FormData();
  form.append(
    "files",
    new Blob([readFileSync(SAMPLE)], { type: "text/csv" }),
    "household-expenses.csv",
  );
  const upload = await call<{ ok: boolean; path: string }>(
    `/api/sources/duckdb/uploads?workspaceId=${encodeURIComponent(workspace)}`,
    cookie,
    { method: "POST", body: form },
  );
  console.log(`smoke-quickstart: uploaded the sample to ${upload.path}`);

  const discovered = await call<{ tables: { name: string }[] }>(
    "/api/sources/discover",
    cookie,
    postJson({ kind: "duckdb", workspaceId: workspace, path: upload.path }),
  );
  const tables = discovered.tables.filter((t) => t.name === "household_expenses");
  if (tables.length !== 1) {
    fail(
      `discovery found ${discovered.tables.map((t) => t.name).join(", ") || "nothing"}`,
    );
  }

  const sourceId = `quickstart-smoke-${Date.now().toString(36)}`;
  await call(
    "/api/sources",
    cookie,
    postJson({
      id: sourceId,
      name: "Quick-start smoke upload",
      workspaceId: workspace,
      config: { kind: "duckdb", path: upload.path, tables },
    }),
  );

  const sql =
    "SELECT category, sum(amount) AS total FROM household_expenses GROUP BY category ORDER BY total DESC";
  const created = await call<{ dashboard: { id: string } }>(
    "/api/dashboards",
    cookie,
    postJson({
      spec: {
        specVersion: SPEC_VERSION,
        title: "Quick-start smoke",
        timeRange: { from: "now-1h", to: "now" },
        panels: [
          {
            id: "by-category",
            title: "Spending by category",
            viz: "table",
            query: { sourceId, sql },
            layout: { x: 0, y: 0, w: 12, h: 4 },
          },
        ],
      },
    }),
  );

  const result = await call<{ rows: unknown[] }>(
    "/api/query",
    cookie,
    postJson({ sourceId, sql, timeRange: { from: "now-1h", to: "now" } }),
  );
  if (result.rows.length === 0) fail("the uploaded file's panel returned no rows");
  console.log(
    `smoke-quickstart: OK, dashboard ${created.dashboard.id} answers with ${result.rows.length} rows from the upload`,
  );
  process.exit(0);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
