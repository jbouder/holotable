import { test } from "node:test";
import assert from "node:assert/strict";
import { type Panel, TimeExpr, TimeRange } from "@/lib/ir";
import { resolveTimeRange } from "@/lib/time";
import {
  absoluteRange,
  brushedRange,
  describeRange,
  formatSpan,
  fromLocalInput,
  isRolling,
  isoExpr,
  matchingPreset,
  parseRelative,
  RANGE_PRESETS,
  rangeFromParams,
  rangeSearch,
  relativeExpr,
  relativeRange,
  rowInstant,
  shiftRange,
  spanMs,
  supportsTimeBrush,
  toLocalInput,
  zoomRange,
} from "@/lib/time-range";

const NOW = new Date("2026-09-22T12:00:00Z");
const HOUR = 3_600_000;

function panel(overrides: Partial<Panel> = {}): Panel {
  return {
    id: "p1",
    title: "Requests",
    viz: "line",
    query: { sourceId: "src-1", sql: "SELECT ts, v FROM m", timeField: "ts" },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    ...overrides,
  };
}

/**
 * The contract the whole module lives under: nothing it emits may be a window
 * the IR would refuse, because the server parses every one of them again.
 */
function assertValid(range: TimeRange) {
  assert.equal(TimeRange.safeParse(range).success, true, JSON.stringify(range));
}

test("parseRelative reads the relative forms and rejects the absolute one", () => {
  assert.deepEqual(parseRelative("now-15m"), { amount: 15, unit: "m" });
  assert.deepEqual(parseRelative("now-7d"), { amount: 7, unit: "d" });
  assert.deepEqual(parseRelative("now"), { amount: 0, unit: "m" });
  assert.equal(parseRelative("2026-09-22T12:00:00Z"), null);
  assert.equal(parseRelative("now-1y"), null);
});

test("a range is rolling only when both ends are relative", () => {
  assert.equal(isRolling({ from: "now-1h", to: "now" }), true);
  assert.equal(isRolling({ from: "now-2h", to: "now-1h" }), true);
  assert.equal(
    isRolling({ from: "2026-09-22T10:00:00Z", to: "2026-09-22T11:00:00Z" }),
    false,
  );
  assert.equal(isRolling({ from: "now-1h", to: "2026-09-22T11:00:00Z" }), false);
});

test("isoExpr trims milliseconds and still satisfies TimeExpr", () => {
  const expr = isoExpr(new Date("2026-09-22T12:00:00.123Z"));
  assert.equal(expr, "2026-09-22T12:00:00Z");
  assert.equal(TimeExpr.safeParse(expr).success, true);
});

test("relativeExpr picks the largest unit that divides evenly", () => {
  assert.equal(relativeExpr(90 * 60_000), "now-90m");
  assert.equal(relativeExpr(2 * HOUR), "now-2h");
  assert.equal(relativeExpr(7 * 86_400_000), "now-1w");
  assert.equal(relativeExpr(90_000), "now-90s");
  // Sub-second and absurd spans are clamped rather than emitted as `now-0…`.
  assert.equal(relativeExpr(1), "now-1s");
  for (const ms of [1, 999, 1000, 61_000, HOUR + 1, 1e15]) {
    assert.equal(TimeExpr.safeParse(relativeExpr(ms)).success, true, String(ms));
  }
});

test("presets are all valid ranges and are recognised as themselves", () => {
  for (const preset of RANGE_PRESETS) {
    const range = { from: preset.from, to: "now" };
    assertValid(range);
    assert.equal(matchingPreset(range), preset.label);
  }
  assert.equal(matchingPreset({ from: "now-90m", to: "now" }), null);
  assert.equal(matchingPreset({ from: "now-1h", to: "now-1m" }), null);
});

test("absoluteRange refuses a window that is not at least a second wide", () => {
  const from = new Date("2026-09-22T10:00:00Z");
  assert.equal(absoluteRange(from, new Date("2026-09-22T10:00:00.500Z")), null);
  assert.equal(absoluteRange(new Date("2026-09-22T11:00:00Z"), from), null);
  const ok = absoluteRange(from, new Date("2026-09-22T11:00:00Z"));
  assert.deepEqual(ok, { from: "2026-09-22T10:00:00Z", to: "2026-09-22T11:00:00Z" });
});

test("shifting back produces an absolute window of the same width", () => {
  const shifted = shiftRange({ from: "now-1h", to: "now" }, -1, NOW);
  assertValid(shifted);
  assert.equal(isRolling(shifted), false);
  assert.deepEqual(shifted, {
    from: "2026-09-22T10:00:00Z",
    to: "2026-09-22T11:00:00Z",
  });
  assert.equal(spanMs(shifted, NOW), HOUR);
});

test("shifting forward past now returns to the rolling window of the same width", () => {
  const back = shiftRange({ from: "now-1h", to: "now" }, -1, NOW);
  const forward = shiftRange(back, 1, NOW);
  assert.deepEqual(forward, { from: "now-1h", to: "now" });
  assert.equal(isRolling(forward), true);

  // Two steps back is still history, so it stays absolute.
  const twoBack = shiftRange(back, -1, NOW);
  assert.equal(isRolling(twoBack), false);
  assert.deepEqual(twoBack, {
    from: "2026-09-22T09:00:00Z",
    to: "2026-09-22T10:00:00Z",
  });
});

test("zooming a live window keeps it live; zooming a fixed one keeps it fixed", () => {
  const live = zoomRange({ from: "now-1h", to: "now" }, 2, NOW);
  assert.deepEqual(live, { from: "now-2h", to: "now" });

  const fixed = zoomRange(
    { from: "2026-09-22T09:00:00Z", to: "2026-09-22T10:00:00Z" },
    2,
    NOW,
  );
  assertValid(fixed);
  assert.equal(isRolling(fixed), false);
  assert.equal(spanMs(fixed, NOW), 2 * HOUR);

  // Zooming in halves it and never inverts it.
  const narrow = zoomRange({ from: "now-1h", to: "now" }, 0.5, NOW);
  assert.deepEqual(narrow, { from: "now-30m", to: "now" });
});

test("zooming out never proposes a window that ends in the future", () => {
  const nearNow = absoluteRange(new Date(NOW.getTime() - 60_000), NOW);
  assert.ok(nearNow);
  const wider = zoomRange(nearNow, 10, NOW);
  const { to } = resolveTimeRange(wider, NOW);
  assert.ok(to.getTime() <= NOW.getTime());
});

test("an unresolvable range is handed back untouched rather than guessed at", () => {
  const broken = { from: "now-1h", to: "now-2h" } satisfies TimeRange;
  assert.deepEqual(shiftRange(broken, -1, NOW), broken);
  assert.deepEqual(zoomRange(broken, 2, NOW), broken);
  assert.equal(spanMs(broken, NOW), null);
});

test("relativeRange only accepts whole positive amounts", () => {
  assert.deepEqual(relativeRange(30, "m"), { from: "now-30m", to: "now" });
  assert.equal(relativeRange(0, "m"), null);
  assert.equal(relativeRange(-5, "h"), null);
  assert.equal(relativeRange(1.5, "h"), null);
  assert.equal(relativeRange(Number.NaN, "h"), null);
});

test("formatSpan and describeRange say which of the three kinds a window is", () => {
  assert.equal(formatSpan(HOUR), "1h");
  assert.equal(formatSpan(90 * 60_000), "1.5h");
  assert.equal(formatSpan(500), "1s");

  assert.equal(describeRange({ from: "now-15m", to: "now" }, NOW), "15m");
  assert.equal(describeRange({ from: "now-90m", to: "now" }, NOW), "Last 1.5h");
  const fixed = describeRange(
    { from: "2026-09-22T09:00:00Z", to: "2026-09-22T10:00:00Z" },
    NOW,
  );
  assert.ok(fixed.includes("→"));
  assert.ok(!fixed.startsWith("Last"));
});

test("datetime-local values round-trip through the local zone", () => {
  const value = "2026-09-22T09:30";
  const date = fromLocalInput(value);
  assert.ok(date);
  assert.equal(toLocalInput(date), value);
  assert.equal(fromLocalInput(""), null);
  assert.equal(fromLocalInput("nonsense"), null);
  assert.equal(fromLocalInput("2026-09-22"), null);
});

test("a URL window is honoured only when the IR accepts it", () => {
  const fallback: TimeRange = { from: "now-1h", to: "now" };
  assert.deepEqual(rangeFromParams({ from: "now-6h", to: "now" }, fallback), {
    from: "now-6h",
    to: "now",
  });
  // Half a range, an injected expression and a repeated parameter all fall back.
  assert.deepEqual(rangeFromParams({ from: "now-6h" }, fallback), fallback);
  assert.deepEqual(rangeFromParams({}, fallback), fallback);
  assert.deepEqual(
    rangeFromParams({ from: "now-6h'; DROP TABLE", to: "now" }, fallback),
    fallback,
  );
  assert.deepEqual(rangeFromParams({ from: ["now-6h", "now-9h"], to: "now" }, fallback), {
    from: "now-6h",
    to: "now",
  });
});

test("the dashboard's own window is not written into the shared link", () => {
  const spec: TimeRange = { from: "now-1h", to: "now" };
  assert.equal(rangeSearch(spec, spec), "");
  assert.equal(rangeSearch({ from: "now-6h", to: "now" }, spec), "?from=now-6h&to=now");
  assert.equal(
    rangeSearch({ from: "2026-09-22T09:00:00Z", to: "2026-09-22T10:00:00Z" }, spec),
    "?from=2026-09-22T09%3A00%3A00Z&to=2026-09-22T10%3A00%3A00Z",
  );
});

test("only ordered time-series vizzes with a time field are brushable", () => {
  assert.equal(supportsTimeBrush(panel({ viz: "line" })), true);
  assert.equal(supportsTimeBrush(panel({ viz: "area" })), true);
  assert.equal(supportsTimeBrush(panel({ viz: "bar" })), true);
  assert.equal(supportsTimeBrush(panel({ viz: "scatter" })), false);
  assert.equal(supportsTimeBrush(panel({ viz: "pie" })), false);
  assert.equal(supportsTimeBrush(panel({ viz: "table" })), false);
  assert.equal(
    supportsTimeBrush(panel({ query: { sourceId: "s", sql: "SELECT 1" } })),
    false,
  );
});

test("rowInstant accepts what a driver actually serializes, and nothing else", () => {
  assert.deepEqual(rowInstant("2026-09-22T10:00:00Z"), new Date("2026-09-22T10:00:00Z"));
  assert.deepEqual(rowInstant(NOW.getTime()), NOW);
  assert.deepEqual(rowInstant(NOW), NOW);
  assert.equal(rowInstant(null), null);
  assert.equal(rowInstant(undefined), null);
  assert.equal(rowInstant("not a time"), null);
  assert.equal(rowInstant({ ts: 1 }), null);
});

test("a brush becomes the absolute window its rows cover", () => {
  const rows = [
    { ts: "2026-09-22T10:00:00Z", v: 1 },
    { ts: "2026-09-22T10:05:00Z", v: 2 },
    { ts: "2026-09-22T10:10:00Z", v: 3 },
    { ts: "2026-09-22T10:15:00Z", v: 4 },
  ];
  const range = brushedRange(rows, "ts", 1, 3);
  assert.deepEqual(range, {
    from: "2026-09-22T10:05:00Z",
    to: "2026-09-22T10:15:00Z",
  });
  assert.ok(range);
  assertValid(range);

  // Indices past the ends are clamped to the rows that exist.
  assert.deepEqual(brushedRange(rows, "ts", -5, 99), {
    from: "2026-09-22T10:00:00Z",
    to: "2026-09-22T10:15:00Z",
  });
});

test("a brush that cannot be read leaves the window alone", () => {
  const rows = [{ ts: "2026-09-22T10:00:00Z" }, { ts: "not a time" }];
  assert.equal(brushedRange(rows, "ts", 0, 1), null);
  assert.equal(brushedRange(rows, undefined, 0, 1), null);
  assert.equal(brushedRange(rows, "ts", 1, 1), null);
  assert.equal(brushedRange([], "ts", 0, 1), null);
});
