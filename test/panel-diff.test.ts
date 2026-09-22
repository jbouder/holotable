import { test } from "node:test";
import assert from "node:assert/strict";
import { Panel as PanelSchema, type Panel } from "@/lib/ir";
import {
  acceptedPanel,
  diffPanels,
  diffSqlLines,
  type PanelDraft,
} from "@/lib/panel-diff";

function panel(overrides: Partial<Panel> = {}): Panel {
  return PanelSchema.parse({
    id: "panel-1",
    title: "Requests",
    viz: "line",
    query: {
      sourceId: "src-1",
      sql: "SELECT ts, count(*)\nFROM requests\nGROUP BY ts",
      timeField: "ts",
    },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    ...overrides,
  });
}

function field(diff: ReturnType<typeof diffPanels>, key: string) {
  const f = diff.fields.find((x) => x.key === key);
  assert.ok(f, `no field ${key}`);
  return f;
}

test("an identical panel produces no changes", () => {
  const before = panel();
  const diff = diffPanels(before, { ...before });
  assert.equal(diff.identical, true);
  assert.equal(diff.changedFields, 0);
  assert.equal(diff.sql.changed, false);
  // Unchanged fields are still listed, so the view can collapse rather than
  // hide them.
  assert.ok(diff.fields.length >= 7);
});

test("only the fields that actually changed are reported as changed", () => {
  const before = panel();
  const diff = diffPanels(before, { ...before, title: "Request rate", viz: "bar" });
  assert.equal(diff.changedFields, 2);
  assert.deepEqual(
    diff.fields.filter((f) => f.changed).map((f) => f.key),
    ["title", "viz"],
  );
  assert.equal(field(diff, "title").before, "Requests");
  assert.equal(field(diff, "title").after, "Request rate");
  assert.equal(field(diff, "layout").changed, false);
  assert.equal(diff.identical, false);
});

test("optional fields render as none and a removal counts as a change", () => {
  const before = panel({ format: "bytes", description: "bytes in" });
  const diff = diffPanels(before, {
    ...before,
    format: undefined,
    description: undefined,
    query: { ...before.query, timeField: undefined },
  });
  assert.equal(field(diff, "format").before, "bytes");
  assert.equal(field(diff, "format").after, "none");
  assert.equal(field(diff, "format").changed, true);
  assert.equal(field(diff, "description").changed, true);
  assert.equal(field(diff, "timeField").changed, true);
});

test("a layout change reads as one field", () => {
  const before = panel();
  const diff = diffPanels(before, {
    ...before,
    layout: { ...before.layout, w: 12 },
  });
  assert.equal(diff.changedFields, 1);
  assert.equal(field(diff, "layout").before, "x 0 · y 0 · w 6 · h 4");
  assert.equal(field(diff, "layout").after, "x 0 · y 0 · w 12 · h 4");
});

test("while streaming, a field that has not arrived is pending, not a change", () => {
  const before = panel({ format: "bytes" });
  const draft: PanelDraft = { title: "Request rate" };
  const diff = diffPanels(before, draft, { streaming: true });
  assert.equal(diff.changedFields, 1);
  assert.equal(field(diff, "title").changed, true);
  const format = field(diff, "format");
  assert.equal(format.pending, true);
  assert.equal(format.changed, false);
  // A pending field shows the current value rather than a hole.
  assert.equal(format.after, "bytes");
  // Nor does a half-arrived layout read as a move.
  assert.equal(field(diff, "layout").changed, false);
  assert.equal(diff.sql.changed, false);
});

test("a partial layout while streaming fills the rest from the current panel", () => {
  const before = panel();
  const diff = diffPanels(before, { layout: { w: 12 } }, { streaming: true });
  assert.equal(field(diff, "layout").after, "x 0 · y 0 · w 12 · h 4");
  assert.equal(field(diff, "layout").changed, true);
});

test("SQL diffs line by line", () => {
  const diff = diffSqlLines("SELECT a\nFROM t\nWHERE x", "SELECT a, b\nFROM t\nWHERE x");
  assert.equal(diff.changed, true);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.deepEqual(
    diff.lines.map((l) => [l.kind, l.text]),
    [
      ["remove", "SELECT a"],
      ["add", "SELECT a, b"],
      ["context", "FROM t"],
      ["context", "WHERE x"],
    ],
  );
});

test("an inserted line keeps the surrounding lines as context", () => {
  const diff = diffSqlLines("SELECT a\nFROM t", "SELECT a\nFROM t\nORDER BY a");
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 0);
  assert.deepEqual(
    diff.lines.map((l) => l.kind),
    ["context", "context", "add"],
  );
  assert.deepEqual(diff.lines.at(-1), {
    kind: "add",
    before: null,
    after: 3,
    text: "ORDER BY a",
  });
});

test("identical SQL is all context and changes nothing", () => {
  const diff = diffSqlLines("SELECT a\nFROM t", "SELECT a\nFROM t");
  assert.equal(diff.changed, false);
  assert.equal(
    diff.lines.every((l) => l.kind === "context"),
    true,
  );
  assert.deepEqual(
    diff.lines.map((l) => [l.before, l.after]),
    [
      [1, 1],
      [2, 2],
    ],
  );
});

test("a statement past the line cap is reported as a whole-block replacement", () => {
  const long = Array.from({ length: 401 }, (_, i) => `SELECT ${i}`).join("\n");
  const diff = diffSqlLines(long, `${long}\nUNION ALL SELECT 1`);
  assert.equal(diff.changed, true);
  assert.equal(diff.removed, 401);
  assert.equal(diff.added, 402);
});

test("a SQL-only change still marks the diff as not identical", () => {
  const before = panel();
  const diff = diffPanels(before, {
    ...before,
    query: { ...before.query, sql: "SELECT ts, count(*)\nFROM requests\nGROUP BY 1" },
  });
  assert.equal(diff.changedFields, 0);
  assert.equal(diff.sql.changed, true);
  assert.equal(diff.identical, false);
});

test("accepting keeps the id of the panel being replaced", () => {
  const before = panel();
  const generated = panel({ id: "panel-invented-by-the-model", title: "New" });
  const applied = acceptedPanel(before, generated);
  assert.equal(applied.id, "panel-1");
  assert.equal(applied.title, "New");
  // Still a valid panel, so the accept cannot produce an unsaveable spec.
  assert.doesNotThrow(() => PanelSchema.parse(applied));
});

test("diffing does not mutate either panel, so rejecting leaves it untouched", () => {
  const before = panel();
  const snapshot = structuredClone(before);
  const generated = panel({ id: "other", title: "New", viz: "bar" });
  diffPanels(before, generated);
  acceptedPanel(before, generated);
  assert.deepEqual(before, snapshot);
});
