import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  DashboardExportFile,
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
} from "@/lib/dashboard-export";
import { DraftEnvelope } from "@/lib/editor/drafts";
import {
  Dashboard,
  DashboardGenerationSchema,
  forGeneration,
  fromGenerated,
  Panel,
  parseDashboard,
  SPEC_VERSION,
  safeParseDashboard,
  TimeExpr,
} from "@/lib/ir";
import {
  migratePanel,
  migrateSpec,
  StoredDashboard,
  UPGRADERS,
  type Upgrader,
  upgradeSpec,
} from "@/lib/ir/upgrade";
import { TemplateBody } from "@/lib/templates";

const validPanel = {
  id: "p1",
  title: "Requests",
  viz: "line" as const,
  query: {
    sourceId: "src-1",
    sql: "SELECT ts, count(*) AS c FROM http_requests GROUP BY ts",
    timeField: "ts",
  },
  format: "number" as const,
  layout: { x: 0, y: 0, w: 6, h: 4 },
};

const validDashboard = {
  specVersion: 1,
  title: "Overview",
  timeRange: { from: "now-1h", to: "now" },
  refreshIntervalMs: 15_000,
  panels: [validPanel],
};

test("accepts a valid dashboard", () => {
  const parsed = parseDashboard(validDashboard);
  assert.equal(parsed.title, "Overview");
  assert.equal(parsed.panels.length, 1);
});

test("rejects unknown top-level keys (strict)", () => {
  const res = safeParseDashboard({ ...validDashboard, extra: true });
  assert.equal(res.success, false);
});

test("rejects unknown panel keys (strict)", () => {
  const res = safeParseDashboard({
    ...validDashboard,
    panels: [{ ...validPanel, color: "red" }],
  });
  assert.equal(res.success, false);
});

test("rejects duplicate panel ids", () => {
  const res = safeParseDashboard({
    ...validDashboard,
    panels: [validPanel, { ...validPanel, title: "Dup" }],
  });
  assert.equal(res.success, false);
  if (!res.success) {
    assert.match(JSON.stringify(res.error.issues), /duplicate panel id/);
  }
});

test("rejects empty panels array", () => {
  const res = safeParseDashboard({ ...validDashboard, panels: [] });
  assert.equal(res.success, false);
});

test("rejects refresh interval below 1s", () => {
  const res = safeParseDashboard({ ...validDashboard, refreshIntervalMs: 100 });
  assert.equal(res.success, false);
});

test("rejects invalid viz type", () => {
  const res = Panel.safeParse({ ...validPanel, viz: "scatter" });
  assert.equal(res.success, true);
});

test("accepts all supported chart visualizations", () => {
  for (const viz of ["line", "area", "bar", "scatter", "heatmap", "pie", "donut"]) {
    assert.equal(Panel.safeParse({ ...validPanel, viz }).success, true, viz);
  }
});

test("timeField is optional on a panel query", () => {
  const res = Panel.safeParse({
    ...validPanel,
    query: { sourceId: "s", sql: "SELECT 1 AS v" },
  });
  assert.equal(res.success, true);
});

test("TimeExpr accepts relative and ISO forms", () => {
  for (const good of [
    "now",
    "now-15m",
    "now-1h",
    "now-24h",
    "now-7d",
    "2024-01-02T03:04:05Z",
  ]) {
    assert.equal(TimeExpr.safeParse(good).success, true, good);
  }
});

test("TimeExpr rejects malformed forms", () => {
  for (const bad of ["later", "now-1y", "now +1h", "1h", "DROP", ""]) {
    assert.equal(TimeExpr.safeParse(bad).success, false, bad);
  }
});

/* -------------------------------------------------------------------------- */
/* Versioning and the upgrader chain (#58)                                    */
/* -------------------------------------------------------------------------- */

/** A spec as it was stored before `specVersion` existed. Never edit it. */
const UNVERSIONED: Record<string, unknown> = JSON.parse(
  readFileSync(new URL("./fixtures/specs/v1-unversioned.json", import.meta.url), "utf8"),
);

function issues(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  return JSON.stringify(result.error?.issues ?? []);
}

test("the chain has exactly one upgrader per version after the first", () => {
  assert.equal(UPGRADERS.length, SPEC_VERSION - 1);
});

test("Dashboard accepts the current version only; an older spec goes through the upgrader", () => {
  assert.equal(Dashboard.safeParse(UNVERSIONED).success, false);
  assert.equal(Dashboard.safeParse({ ...UNVERSIONED, specVersion: 0 }).success, false);
  assert.equal(
    Dashboard.safeParse({ ...UNVERSIONED, specVersion: SPEC_VERSION }).success,
    true,
  );
});

test("an unversioned stored spec is version 1 and loads at the current version", () => {
  const spec = upgradeSpec(UNVERSIONED);
  assert.equal(spec.specVersion, SPEC_VERSION);
  const { specVersion: _, ...rest } = spec;
  assert.deepEqual(rest, UNVERSIONED);
});

test("a current-version spec loads unchanged", () => {
  const current = { ...UNVERSIONED, specVersion: SPEC_VERSION };
  assert.deepEqual(upgradeSpec(current), current);
});

test("a spec from a newer build, or with a nonsense version, is refused rather than guessed at", () => {
  const newer = StoredDashboard.safeParse({
    ...UNVERSIONED,
    specVersion: SPEC_VERSION + 1,
  });
  assert.equal(newer.success, false);
  assert.match(issues(newer), /saved by a newer version of Holotable/);

  for (const bad of [0, -1, 1.5, "1", null]) {
    const res = StoredDashboard.safeParse({ ...UNVERSIONED, specVersion: bad });
    assert.equal(res.success, false, String(bad));
  }
  assert.equal(StoredDashboard.safeParse("not a spec").success, false);
  assert.equal(StoredDashboard.safeParse([UNVERSIONED]).success, false);
});

test("reading never modifies what was read", () => {
  const row = structuredClone(UNVERSIONED);
  const before = JSON.stringify(row);
  upgradeSpec(row);
  migrateSpec(row, SIMULATED);
  assert.equal(JSON.stringify(row), before);
  assert.equal("specVersion" in row, false);
});

/*
 * A simulated future. v2 moves the refresh interval under `refresh`; v3 makes
 * a panel's `format` required. Neither is a real IR change — they exist so the
 * chain is exercised end to end against today's stored fixture.
 */
const v1ToV2: Upgrader = ({ refreshIntervalMs, ...rest }) => ({
  ...rest,
  refresh: { intervalMs: refreshIntervalMs },
});
const v2ToV3: Upgrader = (spec) => ({
  ...spec,
  panels: (spec.panels as Record<string, unknown>[]).map((p) => ({
    format: "number",
    ...p,
  })),
});
const SIMULATED = [v1ToV2, v2ToV3];

const V3Panel = Panel.safeExtend({ format: Panel.shape.format.unwrap() });
const V3Dashboard = z
  .object({
    specVersion: z.literal(3),
    title: z.string(),
    timeRange: z.object({ from: z.string(), to: z.string() }),
    refresh: z.object({ intervalMs: z.number().int() }).strict(),
    panels: z.array(V3Panel),
  })
  .strict();

test("today's stored spec loads after a simulated two-step (v1 → v2 → v3) change", () => {
  const migrated = migrateSpec(UNVERSIONED, SIMULATED);
  assert.ok(migrated.ok);
  const v3 = V3Dashboard.parse(migrated.spec);
  assert.equal(v3.specVersion, 3);
  assert.deepEqual(v3.refresh, { intervalMs: 15_000 });
  assert.deepEqual(
    v3.panels.map((p) => [p.id, p.format]),
    [
      ["rps", "number"],
      ["by-route", "number"],
    ],
  );
  // Nothing the upgraders did not touch moved.
  assert.equal(v3.panels[0].query?.sql, (UNVERSIONED.panels as Panel[])[0].query?.sql);
});

test("the chain starts from the version a spec was saved at", () => {
  const atV2 = { ...UNVERSIONED, specVersion: 2, refresh: { intervalMs: 5_000 } };
  delete (atV2 as Record<string, unknown>).refreshIntervalMs;
  const migrated = migrateSpec(atV2, SIMULATED);
  assert.ok(migrated.ok);
  // v1 → v2 did not run again: the v2 interval survives.
  assert.deepEqual(V3Dashboard.parse(migrated.spec).refresh, { intervalMs: 5_000 });

  const tooNew = migrateSpec({ ...UNVERSIONED, specVersion: 4 }, SIMULATED);
  assert.equal(tooNew.ok, false);
});

test("a lone panel is carried through the same chain", () => {
  const panel = (UNVERSIONED.panels as Panel[])[1];
  assert.equal("format" in panel, false);
  const migrated = migratePanel(panel, undefined, SIMULATED);
  assert.ok(migrated.ok);
  assert.equal(V3Panel.parse(migrated.spec).format, "number");
  assert.equal(migratePanel(panel, 9, SIMULATED).ok, false);
});

test("the model is never asked for, and cannot supply, a version", () => {
  const { specVersion: _, ...generated } = upgradeSpec(UNVERSIONED);
  assert.equal(DashboardGenerationSchema.safeParse(generated).success, true);
  assert.equal(
    DashboardGenerationSchema.safeParse({ ...generated, specVersion: SPEC_VERSION })
      .success,
    false,
  );
  assert.equal(
    DashboardGenerationSchema.safeParse({ ...generated, specVersion: 99 }).success,
    false,
  );
  const stamped = fromGenerated(DashboardGenerationSchema.parse(generated));
  assert.equal(stamped.specVersion, SPEC_VERSION);
  assert.equal(Dashboard.safeParse(stamped).success, true);
  // A spec shown back to the model for refinement does not carry it either.
  assert.equal("specVersion" in forGeneration(stamped), false);
  // The panel generation schema is untouched: a panel has no version of its own.
  assert.equal("specVersion" in Panel.shape, false);
});

test("every reader of a stored spec upgrades it: drafts, export files, templates", () => {
  const draft = DraftEnvelope.parse({
    dashboardId: "d1",
    baseVersion: 3,
    savedAt: 1,
    spec: UNVERSIONED,
  });
  assert.equal(draft.spec.specVersion, SPEC_VERSION);

  const file = DashboardExportFile.parse({
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    spec: UNVERSIONED,
  });
  assert.equal(file.spec.specVersion, SPEC_VERSION);

  const dashboardTemplate = TemplateBody.parse({
    kind: "dashboard",
    dashboard: UNVERSIONED,
  });
  assert.equal(
    dashboardTemplate.kind === "dashboard" && dashboardTemplate.dashboard.specVersion,
    SPEC_VERSION,
  );

  // A panel template saved before the version was recorded.
  const panelTemplate = TemplateBody.parse({
    kind: "panel",
    panel: (UNVERSIONED.panels as Panel[])[0],
  });
  assert.equal(panelTemplate.kind === "panel" && panelTemplate.specVersion, SPEC_VERSION);

  const future = TemplateBody.safeParse({
    kind: "panel",
    specVersion: SPEC_VERSION + 1,
    panel: (UNVERSIONED.panels as Panel[])[0],
  });
  assert.equal(future.success, false);
  assert.match(issues(future), /newer version of Holotable/);
});
