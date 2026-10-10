import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PanelData } from "@/components/charts/options";
import { LogsView } from "@/components/panels/logs";
import { Panel } from "@/lib/ir";
import { fallbackToken } from "@/lib/panels/colors";
import { LOG_LINES_MAX, logLines } from "@/lib/panel-reading";
import type { TimeDisplay } from "@/lib/time-display";

/*
 * The logs panel (#404): rows as lines, newest first, colored by level, the
 * rest of each row behind it.
 */

const LAYOUT = { x: 0, y: 0, w: 12, h: 4 };
const UTC_TIME_DISPLAY: TimeDisplay = { timeZone: "UTC", clock: "24h" };
const T = (s: number) => `2026-10-09T10:00:0${s}Z`;

function logs(options: Record<string, unknown> = {}): Panel {
  return Panel.parse({
    id: "l",
    title: "Gateway",
    viz: "logs",
    query: { sourceId: "s", sql: "SELECT 1", timeField: "ts" },
    options,
    layout: LAYOUT,
  });
}

const LINES: PanelData = {
  columns: ["ts", "level", "host", "message"],
  rows: [
    { ts: T(1), level: "info", host: "a", message: "GET /login 200 in 41 ms" },
    { ts: T(3), level: "ERROR", host: "b", message: "upstream timeout on /checkout" },
    { ts: T(2), level: "warn", host: "a", message: "slow request: /search took 812 ms" },
  ],
};

test("lines are newest first, with the message guessed as the longest text column", () => {
  const { lines } = logLines(logs({ level: "level" }), LINES, UTC_TIME_DISPLAY);
  assert.deepEqual(
    lines.map((l) => l.message),
    [
      "upstream timeout on /checkout",
      "slow request: /search took 812 ms",
      "GET /login 200 in 41 ms",
    ],
  );
  assert.deepEqual(lines[0]?.details, [["host", "b"]]);
  assert.match(lines[0]?.time ?? "", /10:00:03/);
});

test("oldest first when asked", () => {
  const { lines } = logLines(logs({ order: "oldest" }), LINES, UTC_TIME_DISPLAY);
  assert.deepEqual(
    lines.map((l) => l.row.ts),
    [T(1), T(2), T(3)],
  );
});

test("levels take their usual colors in any case, then the panel's, then a stable fallback", () => {
  const data: PanelData = {
    columns: ["ts", "level", "message"],
    rows: [
      { ts: T(1), level: "ERROR", message: "a" },
      { ts: T(2), level: "warn", message: "b" },
      { ts: T(3), level: "debug", message: "c" },
      { ts: T(4), level: "audit", message: "d" },
      { ts: T(5), level: "info", message: "e" },
    ],
  };
  const plain = logLines(logs({ level: "level" }), data).lines;
  assert.deepEqual(
    plain.map((l) => [l.level, l.color]),
    [
      ["info", "info"],
      ["audit", fallbackToken("audit")],
      ["debug", "neutral"],
      ["warn", "warning"],
      ["ERROR", "danger"],
    ],
  );
  const mapped = logLines(
    logs({ level: "level", levels: [{ state: "info", color: "success" }] }),
    data,
  ).lines;
  assert.equal(mapped[0]?.color, "success");
});

test("identical lines keep distinct, stable keys", () => {
  const data: PanelData = {
    columns: ["ts", "message"],
    rows: [
      { ts: T(1), message: "ping" },
      { ts: T(1), message: "ping" },
    ],
  };
  const first = logLines(logs(), data).lines.map((l) => l.key);
  assert.equal(new Set(first).size, 2);
  assert.deepEqual(
    logLines(logs(), data).lines.map((l) => l.key),
    first,
  );
});

test("lines past the cap are counted, not drawn", () => {
  const rows = Array.from({ length: LOG_LINES_MAX + 4 }, (_, i) => ({
    ts: new Date(Date.UTC(2026, 9, 9, 10, 0, 0, i)).toISOString(),
    message: `line ${i}`,
  }));
  const { lines, overflow } = logLines(logs(), { columns: ["ts", "message"], rows });
  assert.equal(lines.length, LOG_LINES_MAX);
  assert.equal(overflow, 4);
  // The newest are the ones kept.
  assert.equal(lines[0]?.message, `line ${LOG_LINES_MAX + 3}`);
});

test("no rows, or rows without a time, draw rather than throw", () => {
  assert.deepEqual(logLines(logs(), { columns: [], rows: [] }).lines, []);
  const odd = logLines(logs(), { columns: ["message"], rows: [{ message: "x" }] });
  assert.deepEqual(
    odd.lines.map((l) => [l.time, l.message]),
    [["", "x"]],
  );
});

test("the options refuse a level colored twice and a raw color", () => {
  const ok = (options: Record<string, unknown>) =>
    Panel.safeParse({
      id: "l",
      title: "Gateway",
      viz: "logs",
      query: { sourceId: "s", sql: "SELECT 1", timeField: "ts" },
      options,
      layout: LAYOUT,
    }).success;
  assert.equal(ok({ message: "m", level: "level", wrap: false, order: "oldest" }), true);
  assert.equal(
    ok({
      levels: [
        { state: "info", color: "info" },
        { state: "info", color: "danger" },
      ],
    }),
    false,
  );
  assert.equal(ok({ levels: [{ state: "info", color: "#00ff00" }] }), false);
});

test("a logs panel needs a time field", () => {
  const parsed = Panel.safeParse({
    id: "l",
    title: "Gateway",
    viz: "logs",
    query: { sourceId: "s", sql: "SELECT 1" },
    layout: LAYOUT,
  });
  assert.equal(parsed.success, false);
});

test("the body is a named, focusable list; a line with other columns is a disclosure", () => {
  const html = renderToStaticMarkup(
    <LogsView panel={logs({ level: "level" })} data={LINES} />,
  );
  assert.match(html, /aria-label="Gateway, log"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /<ol/);
  assert.match(html, /upstream timeout on \/checkout/);
  assert.match(html, /aria-expanded="false"/);
  // The stripe is the level's color; the text stays the foreground color.
  assert.match(html, /border-left-color:#[0-9a-f]{6}/);
});

test("an empty window says so", () => {
  const html = renderToStaticMarkup(
    <LogsView panel={logs()} data={{ columns: [], rows: [] }} />,
  );
  assert.match(html, /No lines in this window/);
});
