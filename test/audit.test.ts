import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { parseGroups } from "@/lib/auth/claims";
import { assertAuthorized, HttpError } from "@/lib/auth/authorize";
import {
  AUDIT_ACTIONS,
  audit,
  auditRow,
  setAuditWriter,
  type AuditRow,
} from "@/lib/audit";
import { auditLimit, auditScope, parseAuditQuery } from "@/lib/audit-query";
import { createLogger, runWithRequest, setLogger } from "@/lib/log";
import { renderMetrics, resetMetricsForTests } from "@/lib/metrics";

/**
 * The audit log (#30): what a row may carry, that writing one never breaks a
 * request, that a refusal is recorded, who may read which rows, and that the
 * table refuses to change what it holds.
 */

const viewer = parseGroups("vic", ["/workspaces/ops/viewer"]);
const admin = parseGroups("sam", [
  "/workspaces/ops/source-admin",
  "/workspaces/fin/viewer",
]);
const platform = parseGroups("pat", ["/platform-admins"]);

/** Collect what `audit()` would write, for the life of `fn`. */
async function captured(fn: () => void | Promise<void>): Promise<AuditRow[]> {
  const rows: AuditRow[] = [];
  const restore = setAuditWriter(async (row) => {
    rows.push(row);
  });
  try {
    await fn();
  } finally {
    restore();
  }
  return rows;
}

function quietly<T>(fn: () => Promise<T>): Promise<{ result: T; logged: string[] }> {
  const logged: string[] = [];
  const restore = setLogger(
    createLogger({ level: "error", format: "json", sink: (line) => logged.push(line) }),
  );
  return fn()
    .then((result) => ({ result, logged }))
    .finally(restore);
}

/* -------------------------------------------------------------------------- */
/* What a row carries                                                         */
/* -------------------------------------------------------------------------- */

test("no credential and no result value reaches a row", () => {
  const row = auditRow({
    actor: admin,
    action: "query.execute",
    workspaceId: "ops",
    resource: { type: "source", id: "metrics" },
    detail: {
      sql: "SELECT avg(v) FROM m WHERE note = 'postgres://u:hunter2@db/x'",
      prompt: "chart latency, my key is sk-abcdefghijklmnopqrstuvwx",
      password: "hunter2",
      dsn: "postgresql://reader:s3cret-pw@db.internal:5432/metrics",
      rows: [{ ts: "2026-10-04T10:00:00Z", v: 98765.4321 }],
      nested: { result: [[424242]], data: { v: 777 } },
    },
  });
  const text = JSON.stringify(row);
  for (const secret of ["hunter2", "s3cret-pw", "sk-abcdefghijklmnopqrstuvwx"]) {
    assert.ok(!text.includes(secret), `${secret} leaked`);
  }
  for (const value of ["98765", "424242", "777"]) {
    assert.ok(!text.includes(value), `result value ${value} leaked`);
  }
  // The statement and the prompt are kept as digests: enough to match two
  // rows that ran the same thing, nothing of what it said.
  assert.match(String((row.detail.sql as { sha256: string }).sha256), /^[0-9a-f]{16}$/);
  assert.match(
    String((row.detail.prompt as { sha256: string }).sha256),
    /^[0-9a-f]{16}$/,
  );
  assert.match(String(row.detail.dsn), /reader:\[redacted\]@db\.internal/);
});

test("a row names its actor, workspace, resource and request", () => {
  const row = runWithRequest(
    { requestId: "req-1", route: "dashboards.update", method: "PUT" },
    () =>
      auditRow({
        actor: viewer,
        action: "dashboard.update",
        workspaceId: "ops",
        resource: { type: "dashboard", id: "d1" },
      }),
  );
  assert.deepEqual(row, {
    workspaceId: "ops",
    actorSub: "vic",
    actorKind: "user",
    action: "dashboard.update",
    resourceType: "dashboard",
    resourceId: "d1",
    outcome: "success",
    requestId: "req-1",
    detail: {},
  });
});

test("the platform-admin bypass and the realm are visible on the row", () => {
  const byAdmin = auditRow({
    actor: platform,
    action: "source.delete",
    workspaceId: "ops",
  });
  assert.equal(byAdmin.detail.platformAdmin, true);
  assert.equal(
    auditRow({ actor: viewer, action: "auth.logout", workspaceId: null }).detail
      .platformAdmin,
    undefined,
  );

  const byRealm = auditRow({
    actor: { kind: "realm", sub: "vic" },
    action: "auth.backchannel_logout",
    workspaceId: null,
  });
  assert.equal(byRealm.actorKind, "realm");
  assert.equal(byRealm.actorSub, "vic");
  assert.equal(byRealm.requestId, null, "outside a request there is no id");
});

test("a resource id the model wrote is bounded and scrubbed", () => {
  const row = auditRow({
    actor: viewer,
    action: "query.execute",
    workspaceId: "ops",
    resource: { type: "source", id: `password=hunter2 ${"x".repeat(500)}` },
  });
  assert.ok((row.resourceId ?? "").length <= 200);
  assert.ok(!row.resourceId?.includes("hunter2"));
});

/* -------------------------------------------------------------------------- */
/* Writing never breaks a request                                             */
/* -------------------------------------------------------------------------- */

test("a failed write is logged and counted, and the caller never sees it", async () => {
  resetMetricsForTests();
  const { logged } = await quietly(async () => {
    for (const writer of [
      async () => {
        throw new Error("audit_log does not exist");
      },
      () => {
        throw new Error("thrown before the promise");
      },
    ]) {
      const restore = setAuditWriter(writer);
      try {
        assert.doesNotThrow(() =>
          audit({ actor: viewer, action: "dashboard.create", workspaceId: "ops" }),
        );
      } finally {
        restore();
      }
    }
    await new Promise((r) => setImmediate(r));
  });
  assert.equal(logged.filter((l) => l.includes("audit.write_failed")).length, 2);
  assert.match(await renderMetrics(), /holotable_audit_write_failures_total 2/);
});

/* -------------------------------------------------------------------------- */
/* Refusals                                                                   */
/* -------------------------------------------------------------------------- */

test("a refusal writes one denied row naming the permission and the resource", async () => {
  const rows = await captured(() => {
    const err = runWithRequest(
      { requestId: "req-9", route: "dashboards.delete", method: "DELETE" },
      () => {
        try {
          assertAuthorized(
            viewer,
            "dashboard:delete",
            { workspaceId: "ops", ownerSub: "someone-else" },
            { type: "dashboard", id: "d1" },
          );
        } catch (e) {
          return e;
        }
      },
    );
    assert.ok(err instanceof HttpError && err.status === 403);
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    workspaceId: "ops",
    actorSub: "vic",
    actorKind: "user",
    action: "authz.denied",
    resourceType: "dashboard",
    resourceId: "d1",
    outcome: "denied",
    requestId: "req-9",
    detail: { permission: "dashboard:delete", route: "dashboards.delete" },
  });
});

test("an allowed check writes nothing", async () => {
  const rows = await captured(() => {
    assertAuthorized(viewer, "dashboard:view", { workspaceId: "ops" });
    assertAuthorized(platform, "source:manage", { workspaceId: "anything" });
  });
  assert.deepEqual(rows, []);
});

/* -------------------------------------------------------------------------- */
/* Who reads what                                                             */
/* -------------------------------------------------------------------------- */

test("a source-admin reads their own workspaces; the filter narrows, never widens", () => {
  assert.deepEqual(auditScope(admin, null), ["ops"], "viewer of fin is not enough");
  assert.deepEqual(auditScope(admin, "ops"), ["ops"]);
  assert.deepEqual(auditScope(admin, "fin"), []);
  assert.deepEqual(auditScope(admin, "elsewhere"), []);
  assert.deepEqual(auditScope(viewer, null), []);
  assert.deepEqual(auditScope(viewer, "ops"), []);
});

test("a platform admin reads any workspace, and everything with no filter", () => {
  assert.deepEqual(auditScope(platform, "elsewhere"), ["elsewhere"]);
  assert.equal(auditScope(platform, null), null);
});

test("the query string is parsed strictly, and the server resolves the window", () => {
  const now = new Date("2026-10-04T12:00:00Z");
  const q = parseAuditQuery(
    admin,
    new URLSearchParams(
      "workspaceId=ops&from=now-24h&to=now&action=authz.denied&outcome=denied&before=42&limit=9999",
    ),
    now,
  );
  assert.deepEqual(q, {
    workspaceIds: ["ops"],
    from: new Date("2026-10-03T12:00:00Z"),
    to: now,
    action: "authz.denied",
    outcome: "denied",
    before: BigInt(42),
    limit: 500,
  });

  for (const bad of [
    "action=dashboard.drop",
    "outcome=maybe",
    "from=yesterday",
    "from=now&to=now-1h",
    "before=0",
    "before=abc",
    "before=-1",
  ]) {
    assert.throws(
      () => parseAuditQuery(admin, new URLSearchParams(bad), now),
      (err: unknown) => err instanceof HttpError && err.status === 400,
      bad,
    );
  }
  assert.equal(auditLimit(null), 100);
  assert.equal(auditLimit("0"), 100);
  assert.equal(auditLimit("25"), 25);
});

/* -------------------------------------------------------------------------- */
/* Every listed event is emitted where it happens                             */
/* -------------------------------------------------------------------------- */

const api = (path: string) =>
  readFileSync(new URL(`../src/app/api/${path}/route.ts`, import.meta.url), "utf8");

/** The route that records each event. A route may record more than one. */
const EMITTERS: Record<string, string[]> = {
  "auth/callback": ["auth.login"],
  "auth/login": ["auth.login"],
  "auth/logout": ["auth.logout"],
  "auth/backchannel-logout": ["auth.backchannel_logout"],
  dashboards: ["dashboard.create"],
  "dashboards/import": ["dashboard.create"],
  "dashboards/[id]/duplicate": ["dashboard.create"],
  "dashboards/[id]": ["dashboard.update", "dashboard.delete"],
  "dashboards/[id]/versions/[version]/restore": ["dashboard.update"],
  "dashboards/[id]/stream": ["dashboard.stream"],
  "dashboards/[id]/chat": ["dashboard.chat", "query.execute"],
  chat: ["chat.create", "chat.delete"],
  "chat/[id]": ["chat.update", "chat.delete"],
  "chat/[id]/messages": ["chat.turn", "query.execute"],
  "chat/[id]/panels/[panelId]/run": ["query.execute"],
  generate: ["dashboard.generate"],
  query: ["query.execute"],
  "variables/options": ["query.execute"],
  sources: ["source.create"],
  "sources/[id]": ["source.update", "source.delete"],
  "sources/[id]/catalog": ["source.update"],
  "sources/[id]/test": ["source.test"],
  "sources/[id]/refresh": ["source.refresh"],
  "sources/discover": ["source.discover"],
  "sources/generate": ["source.draft"],
  templates: ["template.create"],
  "templates/[id]": ["template.delete"],
  "workspaces/[id]/limits": ["workspace.limits.update"],
  "workspaces/[id]/prompt": ["workspace.prompt.update"],
  "workspaces/[id]/model": ["workspace.model.update"],
  "workspaces/[id]/model/test": ["workspace.model.test"],
  "me/model": ["user.model.update", "user.model.delete"],
  "me/model/test": ["user.model.test"],
  "workspaces/[id]/annotations": ["annotation.create"],
  "workspaces/[id]/annotations/[annotationId]": ["annotation.delete"],
  "dashboards/[id]/shares": ["share.create"],
  "dashboards/[id]/shares/[shareId]": ["share.revoke"],
  "workspaces/[id]/tokens": ["token.create"],
  "workspaces/[id]/tokens/[tokenId]": ["token.revoke"],
};

/**
 * The MCP tools (#148) record the same events as the routes they mirror, from
 * `src/lib/mcp/tools/`; held here the same way.
 */
const MCP_EMITTERS: Record<string, string[]> = {
  sql: ["query.execute"],
  dashboards: ["dashboard.create", "dashboard.update"],
  generate: ["dashboard.generate", "source.draft"],
};

test("each MCP tool records the event its route records", () => {
  for (const [file, actions] of Object.entries(MCP_EMITTERS)) {
    const source = readFileSync(
      new URL(`../src/lib/mcp/tools/${file}.ts`, import.meta.url),
      "utf8",
    );
    for (const action of actions) {
      assert.ok(
        source.includes(`action: "${action}"`),
        `mcp/tools/${file} does not record ${action}`,
      );
    }
    assert.match(source, /via: "mcp"/, `mcp/tools/${file} names mcp as the way in`);
  }
});

test("each listed event is recorded by the route where it happens", () => {
  for (const [path, actions] of Object.entries(EMITTERS)) {
    const source = api(path);
    for (const action of actions) {
      assert.ok(
        source.includes(`action: "${action}"`),
        `${path} does not record ${action}`,
      );
    }
  }
  const emitted = new Set([...Object.values(EMITTERS).flat(), "authz.denied"]);
  assert.deepEqual(
    AUDIT_ACTIONS.filter((a) => !emitted.has(a)),
    [],
    "an action nothing records",
  );
});

/* -------------------------------------------------------------------------- */
/* Append-only, against a real server                                         */
/* -------------------------------------------------------------------------- */

const migration = readFileSync(
  new URL("../migrations/012_audit_log.sql", import.meta.url),
  "utf8",
);

test("the migration refuses every change to a stored row", () => {
  assert.match(migration, /BEFORE UPDATE OR DELETE ON audit_log\s+FOR EACH ROW/);
  assert.match(migration, /BEFORE TRUNCATE ON audit_log\s+FOR EACH STATEMENT/);
});

const dbUrl = process.env.MIGRATE_TEST_DATABASE_URL;

test("the table's own owner can insert and read, and cannot change or remove", {
  skip: dbUrl ? false : "run with npm run test:integration (needs Docker)",
}, async () => {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  // A scratch schema, so this touches nothing a migration run owns.
  const schema = `audit_test_${process.pid}`;
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(migration.split(/^-- rollback:/m)[0]);
    await client.query(
      `INSERT INTO audit_log (actor_sub, actor_kind, action, outcome)
       VALUES ('vic', 'user', 'auth.login', 'success')`,
    );
    const { rows } = await client.query("SELECT actor_sub FROM audit_log");
    assert.deepEqual(rows, [{ actor_sub: "vic" }]);

    for (const change of [
      "UPDATE audit_log SET actor_sub = 'someone-else'",
      "DELETE FROM audit_log",
      "TRUNCATE audit_log",
    ]) {
      await assert.rejects(client.query(change), /append-only/, change);
    }
    const after = await client.query("SELECT actor_sub FROM audit_log");
    assert.deepEqual(after.rows, [{ actor_sub: "vic" }]);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});
