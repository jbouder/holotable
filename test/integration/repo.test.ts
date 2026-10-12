import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closePool, query } from "@/lib/db/pg";
import {
  createDashboard,
  createSource,
  deleteSource,
  getDashboardById,
  getDashboardVersion,
  getSourceById,
  listDashboardVersions,
  listSources,
  recordCatalogFacts,
  saveDashboardVersion,
  sourceImpact,
  updateSource,
} from "@/lib/db/repo";
import { config } from "@/lib/config";
import { type Dashboard, SPEC_VERSION } from "@/lib/ir";
import { upgradeSpec } from "@/lib/ir/upgrade";
import { SourceConfig } from "@/lib/registry";
import { loadFixtureLibrary } from "../../scripts/lib/spec-fixtures";
import { serverKind } from "@/lib/sources/server/registry";
import { closeSourcePools } from "@/lib/timescaledb/pool";
import { connection, grantRef, HTTP_REQUESTS, needsDb, unique } from "./support";

/*
 * The repository against the real config store (#87): what goes into the
 * jsonb columns comes back as it went in, and versions stay immutable.
 */

const WORKSPACE = unique("ws-repo");

after(async () => {
  if (!process.env.MIGRATE_TEST_DATABASE_URL) return;
  await query("UPDATE dashboards SET current_version_id = NULL WHERE workspace_id = $1", [
    WORKSPACE,
  ]);
  await query("DELETE FROM dashboards WHERE workspace_id = $1", [WORKSPACE]);
  await query("DELETE FROM sources WHERE workspace_id = $1", [WORKSPACE]);
  await closePool();
});

function spec(title: string, panels = 1): Dashboard {
  return {
    specVersion: SPEC_VERSION,
    title,
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 15_000,
    panels: Array.from({ length: panels }, (_, i) => ({
      id: `p${i}`,
      title: `Panel ${i}`,
      viz: "line" as const,
      query: {
        sourceId: "src",
        sql: "SELECT time_bucket('1 minute', ts) AS minute, count(*) AS n FROM http_requests GROUP BY minute",
        timeField: "minute",
      },
      layout: { x: 0, y: i * 4, w: 6, h: 4 },
    })),
  };
}

test(
  "a Loki source stores and loads through its kind, with no secret_ref for auth none (#562)",
  needsDb,
  async () => {
    const config = SourceConfig.parse({
      kind: "loki",
      url: "https://logs.example.com",
      auth: "none",
      labels: [{ name: "app", values: ["api"] }],
      rowFilter: { label: "app", claim: "tenant" },
    });
    const id = unique("src-loki");
    const created = await createSource({
      id,
      workspaceId: WORKSPACE,
      name: "Loki",
      config,
      secretRef: null,
      createdBy: "integration",
    });
    assert.equal(created.kind, "loki");
    assert.equal(created.secretRef, null);
    assert.deepEqual(created.config, config);
    assert.deepEqual(await getSourceById(id), created);
    // Nothing references it, so it goes rather than tombstones.
    assert.equal(await deleteSource(WORKSPACE, id), "deleted");
  },
);

test(
  "a Prometheus source with no auth stores no secret_ref, and one can be set and cleared (#385)",
  needsDb,
  async () => {
    const config = SourceConfig.parse({
      kind: "prometheus",
      url: "https://prom.example.com",
      auth: "none",
      metrics: [{ name: "up", labels: ["job"] }],
    });
    const id = unique("src-prom");
    const created = await createSource({
      id,
      workspaceId: WORKSPACE,
      name: "Prometheus",
      config,
      secretRef: null,
      createdBy: "integration",
    });
    assert.equal(created.kind, "prometheus");
    assert.equal(created.secretRef, null);
    assert.deepEqual(created.config, config);
    assert.deepEqual(await getSourceById(id), created);

    const bearer = SourceConfig.parse({ ...config, auth: "bearer" });
    const withRef = await updateSource(WORKSPACE, id, {
      config: bearer,
      secretRef: "HT_IT_PROM",
    });
    assert.equal(withRef?.secretRef, "HT_IT_PROM");
    // An unrelated edit leaves the reference alone; null clears it.
    assert.equal(
      (await updateSource(WORKSPACE, id, { name: "Renamed" }))?.secretRef,
      "HT_IT_PROM",
    );
    const cleared = await updateSource(WORKSPACE, id, { config, secretRef: null });
    assert.equal(cleared?.secretRef, null);

    // A PromQL panel names its source as a SQL one does, so impact and
    // tombstoning are the same for either kind (#386).
    const promSpec = spec("Reads Prometheus");
    await createDashboard({
      workspaceId: WORKSPACE,
      createdBy: "integration",
      spec: {
        ...promSpec,
        panels: promSpec.panels.map((p) => ({
          ...p,
          viz: "stat" as const,
          query: { sourceId: id, promql: "sum(up)", instant: true },
        })),
      } as Dashboard,
    });
    const impact = await sourceImpact(WORKSPACE, id);
    assert.equal(impact.dashboards.length, 1);
    assert.equal(impact.dashboards[0].title, "Reads Prometheus");
    assert.equal(impact.dashboards[0].panels.length, 1);
    assert.equal(await deleteSource(WORKSPACE, id), "tombstoned");
  },
);

test("a source round-trips, updates and tombstones", needsDb, async () => {
  const config = SourceConfig.parse({
    ...connection(),
    schema: "metrics",
    tables: [HTTP_REQUESTS],
  });
  const id = unique("src-repo");
  const created = await createSource({
    id,
    workspaceId: WORKSPACE,
    name: "Repo source",
    config,
    secretRef: "HT_IT_REPO",
    createdBy: "integration",
  });
  assert.deepEqual(created.config, config);
  assert.equal(created.tombstonedAt, null);
  assert.deepEqual(await getSourceById(id), created);

  const renamed = await updateSource(WORKSPACE, id, { name: "Renamed" });
  assert.equal(renamed?.name, "Renamed");
  assert.deepEqual(renamed?.config, config);
  // Scoped to the workspace: another one cannot update it.
  assert.equal(await updateSource(unique("ws-other"), id, { name: "nope" }), null);

  assert.deepEqual(
    (await listSources(WORKSPACE)).map((s) => s.id),
    [id],
  );
  // Referenced by a saved version, it is tombstoned, never deleted: the
  // dashboard keeps naming it and its panels render as removed.
  const ref = spec("References the source");
  await createDashboard({
    workspaceId: WORKSPACE,
    createdBy: "integration",
    spec: {
      ...ref,
      panels: ref.panels.map((p) => ({ ...p, query: { ...p.query, sourceId: id } })),
    } as Dashboard,
  });
  assert.equal(await deleteSource(WORKSPACE, id), "tombstoned");
  assert.ok((await getSourceById(id))?.tombstonedAt);

  // Referenced by nothing, it is deleted outright.
  const loose = unique("src-loose");
  await createSource({
    id: loose,
    workspaceId: WORKSPACE,
    name: "Loose",
    config,
    secretRef: "HT_IT_REPO",
    createdBy: "integration",
  });
  assert.equal(await deleteSource(WORKSPACE, loose), "deleted");
  assert.equal(await getSourceById(loose), null);
  assert.deepEqual(await listSources(WORKSPACE), []);
});

test(
  "Test and Refresh record what the server is, and nothing else does (#557)",
  needsDb,
  async () => {
    grantRef("HT_IT_FACTS", WORKSPACE, "readonly");
    const id = unique("src-facts");
    const created = await createSource({
      id,
      workspaceId: WORKSPACE,
      name: "Facts",
      config: SourceConfig.parse({
        ...connection(),
        schema: "metrics",
        tables: [HTTP_REQUESTS],
      }),
      secretRef: "HT_IT_FACTS",
      createdBy: "integration",
    });
    // Never tested: nothing recorded, which prompts as before.
    assert.equal(created.catalogFacts, null);

    // Test reads pg_extension; the integration database has TimescaleDB.
    const kind = serverKind(created);
    const result = await kind.test(created);
    assert.equal(result.ok, true, result.message);
    const facts = kind.testFacts(result);
    assert.ok(facts && typeof facts.timescaledb === "string");
    await recordCatalogFacts(WORKSPACE, id, facts);
    const tested = await getSourceById(id);
    assert.deepEqual(tested?.catalogFacts, facts);
    // A Test is not an edit.
    assert.deepEqual(tested?.updatedAt, created.updatedAt);
    // Scoped to the workspace from the record.
    await recordCatalogFacts(unique("ws-other"), id, { timescaledb: null });
    assert.deepEqual((await getSourceById(id))?.catalogFacts, facts);

    // An applied refresh writes them from its own introspection.
    await recordCatalogFacts(WORKSPACE, id, { timescaledb: null });
    const refresh = await kind.refresh((await getSourceById(id)) ?? created);
    assert.deepEqual(refresh.facts, facts);
    const refreshed = await updateSource(WORKSPACE, id, {
      config: refresh.config,
      catalogRefreshedAt: new Date(),
      catalogMissingTables: refresh.missingTables,
      catalogFacts: refresh.facts,
    });
    assert.deepEqual(refreshed?.catalogFacts, facts);
    // An edit leaves them alone.
    const renamed = await updateSource(WORKSPACE, id, { name: "Renamed" });
    assert.deepEqual(renamed?.catalogFacts, facts);

    // A value that no longer parses reads as never recorded.
    await query(`UPDATE sources SET catalog_facts = '{"timescaledb": 7}' WHERE id = $1`, [
      id,
    ]);
    assert.equal((await getSourceById(id))?.catalogFacts, null);
    await deleteSource(WORKSPACE, id);
    await closeSourcePools();
  },
);

test("dashboard versions are immutable and numbered in order", needsDb, async () => {
  const created = await createDashboard({
    workspaceId: WORKSPACE,
    createdBy: "integration",
    spec: spec("First"),
    tags: ["Integration"],
  });
  assert.equal(created.version, 1);

  const second = await saveDashboardVersion({
    dashboardId: created.id,
    createdBy: "integration",
    spec: spec("Second", 2),
    note: "two panels",
  });
  const third = await saveDashboardVersion({
    dashboardId: created.id,
    createdBy: "integration",
    spec: spec("Third", 3),
  });
  assert.deepEqual([second.version, third.version], [2, 3]);

  const current = await getDashboardById(created.id);
  assert.equal(current?.version, 3);
  assert.equal(current?.title, "Third");
  assert.deepEqual(current?.spec, spec("Third", 3));

  // The first version is what was saved then, not what is current now.
  const v1 = await getDashboardVersion(created.id, 1);
  assert.deepEqual(v1?.spec, spec("First"));

  const page = await listDashboardVersions(created.id, { limit: 2 });
  assert.deepEqual(
    page.versions.map((v) => [v.version, v.panelCount, v.note]),
    [
      [3, 3, null],
      [2, 2, "two panels"],
    ],
  );
  assert.equal(page.nextBefore, 2);
  const rest = await listDashboardVersions(created.id, { limit: 2, before: 2 });
  assert.deepEqual(
    rest.versions.map((v) => v.version),
    [1],
  );
});

test(
  "every IR fixture survives the jsonb column and loads back upgraded",
  needsDb,
  async () => {
    // A stored spec of any version, written as the row would hold it and read
    // through the repository: the round trip the fixture library promises (#90).
    const created = await createDashboard({
      workspaceId: WORKSPACE,
      createdBy: "integration",
      spec: spec("Fixture host"),
    });
    const { fixtures } = loadFixtureLibrary();
    for (const [i, fixture] of fixtures.entries()) {
      const version = i + 2;
      await query(
        `INSERT INTO dashboard_versions (dashboard_id, version, spec, created_by)
       VALUES ($1, $2, $3, 'integration')`,
        [created.id, version, JSON.stringify(fixture.spec)],
      );
      const read = await getDashboardVersion(created.id, version);
      assert.deepEqual(read?.spec, upgradeSpec(fixture.spec), fixture.file);
    }
  },
);

test(
  "past DASHBOARD_VERSIONS_KEEP a save removes the oldest version, never the current one",
  needsDb,
  async () => {
    const keep = config.dashboardVersionsKeep;
    assert.ok(keep > 0, "the default keeps a bounded number");
    const d = await createDashboard({
      workspaceId: WORKSPACE,
      createdBy: "tester",
      spec: spec("Versions cap"),
    });
    for (let v = 2; v <= keep + 1; v++) {
      await saveDashboardVersion({
        dashboardId: d.id,
        createdBy: "tester",
        spec: spec(`Versions cap ${v}`),
      });
    }
    const rows = await query<{ version: number }>(
      "SELECT version FROM dashboard_versions WHERE dashboard_id = $1 ORDER BY version",
      [d.id],
    );
    assert.equal(rows.length, keep);
    assert.equal(rows[0].version, 2, "version 1 went first");
    assert.equal(rows.at(-1)?.version, keep + 1);
    const current = await getDashboardById(d.id);
    assert.equal(current?.version, keep + 1, "the current version is the newest kept");
  },
);
