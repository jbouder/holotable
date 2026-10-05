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
  saveDashboardVersion,
  updateSource,
} from "@/lib/db/repo";
import { type Dashboard, SPEC_VERSION } from "@/lib/ir";
import { upgradeSpec } from "@/lib/ir/upgrade";
import { SourceConfig } from "@/lib/registry";
import { loadFixtureLibrary } from "../../scripts/lib/spec-fixtures";
import { connection, HTTP_REQUESTS, needsDb, unique } from "./support";

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
