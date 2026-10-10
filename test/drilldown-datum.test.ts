import { test } from "node:test";
import { isDatumLink } from "@/lib/ir";
import assert from "node:assert/strict";
import { datumClick, isBrushClick } from "@/components/charts/EChart";
import type { PanelData } from "@/components/charts/options";
import {
  type Datum,
  datumLinkItems,
  hasDatumLinks,
  linkHref,
  linkPicks,
  menuLinks,
  seriesLabel,
} from "@/lib/drilldown";
import { type DatumClick, datumOf, datumOfRow } from "@/lib/drilldown-datum";
import type { Panel, PanelLink, VizType } from "@/lib/ir";
import { PANEL_KIND_NAMES } from "@/lib/panels/registry";

/** Drilldown, Phase 3 (#373): from a click to the row it was drawn from. */

function panel(viz: VizType, extra: Partial<Panel> = {}): Panel {
  return {
    id: "p",
    title: "P",
    viz,
    query: { sourceId: "s", sql: "SELECT 1" },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    ...extra,
  } as Panel;
}

const T = (m: number) => `2026-10-09T10:0${m}:00Z`;

const SERIES: PanelData = {
  columns: ["minute", "requests", "errors"],
  rows: [
    { minute: T(0), requests: 10, errors: 1 },
    { minute: T(1), requests: 12, errors: 0 },
  ],
};

const BY_HOST: PanelData = {
  columns: ["host", "cpu"],
  rows: [
    { host: "web-01", cpu: 40 },
    { host: "web-02", cpu: 90 },
  ],
};

interface Case {
  panel: Panel;
  data: PanelData;
  click: DatumClick;
  expect: Datum | null;
}

/**
 * One case per registered kind. The test below fails when a kind is
 * registered without one, so a new kind has to say how a click maps back.
 */
const CASES: Record<VizType, Case> = {
  line: {
    panel: panel("line", { query: { sourceId: "s", sql: "x", timeField: "minute" } }),
    data: SERIES,
    click: { seriesName: "errors", dataIndex: 1 },
    expect: { row: SERIES.rows[1] as Record<string, unknown>, series: "errors" },
  },
  area: {
    panel: panel("area", { query: { sourceId: "s", sql: "x", timeField: "minute" } }),
    data: SERIES,
    click: { seriesName: "requests", dataIndex: 0 },
    expect: { row: SERIES.rows[0] as Record<string, unknown>, series: "requests" },
  },
  bar: {
    panel: panel("bar"),
    data: BY_HOST,
    click: { seriesName: "cpu", dataIndex: 1 },
    expect: { row: BY_HOST.rows[1] as Record<string, unknown>, series: "cpu" },
  },
  scatter: {
    panel: panel("scatter"),
    data: {
      columns: ["bytes", "ms"],
      rows: [
        { bytes: 1, ms: 2 },
        { bytes: 3, ms: 4 },
      ],
    },
    click: { seriesName: "ms", dataIndex: 1 },
    expect: { row: { bytes: 3, ms: 4 }, series: "ms" },
  },
  stat: {
    panel: panel("stat"),
    data: { columns: ["n"], rows: [{ n: 1 }, { n: 2 }] },
    click: {},
    expect: { row: { n: 2 } },
  },
  table: {
    // Sorted by cpu descending: the first row shown is web-02.
    panel: panel("table", { options: { sort: { column: "cpu", order: "desc" } } }),
    data: BY_HOST,
    click: { dataIndex: 0 },
    expect: { row: { host: "web-02", cpu: 90 } },
  },
  heatmap: {
    panel: panel("heatmap"),
    data: {
      columns: ["hour", "host", "n"],
      rows: [
        { hour: "10", host: "a", n: 1 },
        { hour: "10", host: "b", n: 2 },
      ],
    },
    click: { dataIndex: 1 },
    expect: { row: { hour: "10", host: "b", n: 2 }, series: "b" },
  },
  pie: {
    panel: panel("pie"),
    data: {
      columns: ["service", "n"],
      rows: [
        { service: "api", n: 3 },
        { service: "web", n: 1 },
      ],
    },
    click: { dataIndex: 1, name: "web" },
    expect: { row: { service: "web", n: 1 }, series: "web" },
  },
  donut: {
    panel: panel("donut"),
    data: { columns: ["service", "n"], rows: [{ service: "api", n: 3 }] },
    click: { dataIndex: 0, name: "api" },
    expect: { row: { service: "api", n: 3 }, series: "api" },
  },
  gauge: {
    panel: panel("gauge", { options: { variant: "bar" } }),
    data: BY_HOST,
    // Readings are sorted by value: index 0 is web-02, but the name wins.
    click: { dataIndex: 0, name: "web-01" },
    expect: { row: { host: "web-01", cpu: 40 }, series: "web-01" },
  },
  "state-timeline": {
    panel: panel("state-timeline", {
      query: { sourceId: "s", sql: "x", timeField: "ts" },
    }),
    data: {
      columns: ["ts", "host", "state"],
      rows: [
        { ts: T(0), host: "a", state: "ok" },
        { ts: T(1), host: "a", state: "hot" },
        { ts: T(2), host: "b", state: "ok" },
      ],
    },
    // Spans in lane order: a/ok, a/hot, b/ok.
    click: { dataIndex: 1 },
    expect: { row: { ts: T(1), host: "a", state: "hot" }, series: "a" },
  },
  histogram: {
    panel: panel("histogram"),
    data: {
      columns: ["bucket", "requests"],
      rows: [
        { bucket: 100, requests: 3 },
        { bucket: 0, requests: 5 },
        { bucket: 100, requests: 2 },
      ],
    },
    // Bars are ordered by bucket and summed: index 1 is 100, with 3 + 2.
    click: { dataIndex: 1 },
    expect: { row: { bucket: 100, requests: 5 }, series: "100" },
  },
  "status-grid": {
    panel: panel("status-grid", { options: { sort: "value" } }),
    data: BY_HOST,
    // Tiles are sorted by value: index 0 is web-02, but the name wins.
    click: { dataIndex: 0, name: "web-01" },
    expect: { row: { host: "web-01", cpu: 40 }, series: "web-01" },
  },
  text: {
    panel: {
      id: "t",
      title: "T",
      viz: "text",
      options: { content: "x" },
      layout: { x: 0, y: 0, w: 6, h: 2 },
    },
    data: { columns: [], rows: [] },
    click: { dataIndex: 0 },
    expect: null,
  },
};

test("every registered kind says how a click maps back to a row", () => {
  assert.deepEqual(Object.keys(CASES).sort(), [...PANEL_KIND_NAMES].sort());
});

for (const [kind, c] of Object.entries(CASES)) {
  test(`datumOf: ${kind}`, () => {
    assert.deepEqual(datumOf(c.panel, c.data, c.click), c.expect);
  });
}

test("a radial gauge's datum is its latest row", () => {
  assert.deepEqual(datumOf(panel("gauge"), BY_HOST, {}), {
    row: { host: "web-02", cpu: 90 },
    series: "cpu",
  });
});

test("a click datumOf cannot place is no datum, never a guess", () => {
  for (const dataIndex of [-1, 2, 0.5, undefined]) {
    assert.equal(datumOf(panel("bar"), BY_HOST, { dataIndex }), null, String(dataIndex));
  }
  assert.equal(datumOf(panel("line"), undefined, { dataIndex: 0 }), null);
  // A malformed row is dropped the way the chart drops it, so indices still agree.
  const messy = {
    columns: ["host", "cpu"],
    rows: [null, ...BY_HOST.rows],
  } as unknown as PanelData;
  assert.deepEqual(datumOf(panel("bar"), messy, { dataIndex: 0 })?.row, BY_HOST.rows[0]);
});

test("a hidden-table row stands for its point, with the series the kind names per row", () => {
  assert.deepEqual(datumOfRow(panel("pie"), BY_HOST, 1), {
    row: BY_HOST.rows[1],
    series: "web-02",
  });
  // One numeric series: that is the row's series. Several: none.
  assert.equal(datumOfRow(panel("bar"), BY_HOST, 0)?.series, "cpu");
  const line = panel("line", { query: { sourceId: "s", sql: "x", timeField: "minute" } });
  assert.equal(datumOfRow(line, SERIES, 0)?.series, undefined);
  assert.deepEqual(datumOfRow(panel("stat"), BY_HOST, 0), { row: BY_HOST.rows[0] });
  assert.equal(datumOfRow(panel("bar"), BY_HOST, 5), null);
});

// ---------------------------------------------------------------------------
// From a datum to picks
// ---------------------------------------------------------------------------

const HOST = "11111111-1111-4111-8111-111111111111";

function link(l: Partial<PanelLink>): PanelLink {
  return { title: "Host", dashboard: HOST, ...l };
}

test("a column pick reads the row, a series pick the series, literals stand", () => {
  const l = link({
    set: { host: { column: "host" }, metric: { series: true }, env: { value: "prod" } },
  });
  assert.deepEqual(linkPicks(l, { row: { host: "web-01", cpu: 9 }, series: "cpu" }), {
    host: ["web-01"],
    metric: ["cpu"],
    env: ["prod"],
  });
  // Without a datum only the literals are picked.
  assert.deepEqual(linkPicks(l), { env: ["prod"] });
});

test("what a datum cannot supply is left unset, so the target uses its default", () => {
  const l = link({ set: { host: { column: "host" }, metric: { series: true } } });
  assert.deepEqual(linkPicks(l, { row: { cpu: 9 } }), {});
  assert.deepEqual(linkPicks(l, { row: { host: null } }), {});
  assert.deepEqual(linkPicks(l, { row: { host: "" } }), {});
  assert.deepEqual(linkPicks(l, { row: { host: "x".repeat(257) } }), {});
  assert.deepEqual(linkPicks(l, { row: { host: { nested: 1 } } }), {});
  // An inherited key is not a column.
  assert.deepEqual(
    linkPicks(link({ set: { host: { column: "toString" } } }), { row: {} }),
    {},
  );
  // Numbers and booleans are picked as text.
  assert.deepEqual(linkPicks(l, { row: { host: 42 }, series: "cpu" }), {
    host: ["42"],
    metric: ["cpu"],
  });
});

test("the href a click builds carries the datum's picks over the carried ones", () => {
  const href = linkHref(
    link({ set: { host: { column: "host" } } }),
    HOST,
    {
      timeRange: { from: "now-6h", to: "now" },
      selection: { host: ["old"], env: ["prod"] },
    },
    { row: { host: "web-02" } },
  );
  const params = new URL(href, "http://holotable.test").searchParams;
  assert.deepEqual(params.getAll("var-host"), ["web-02"]);
  assert.deepEqual(params.getAll("var-env"), ["prod"]);
  assert.equal(params.get("from"), "now-6h");
});

test("a click offers only the datum links the viewer can follow; the menu offers none of them", () => {
  const p = panel("bar", {
    links: [
      link({ title: "Host", set: { host: { column: "host" } } }),
      link({
        title: "Gone",
        dashboard: "22222222-2222-4222-8222-222222222222",
        set: { host: { column: "host" } },
      }),
      { title: "Filter", set: { host: { column: "host" } } },
      link({ title: "Panel link" }),
    ],
  });
  const targets = { [HOST]: { title: "Host detail" } };
  const context = { timeRange: { from: "now-1h", to: "now" }, selection: {} };
  const items = datumLinkItems(p, targets, context, { row: { host: "web-01" } });
  assert.deepEqual(
    items.map((i) => [i.kind, i.title]),
    [
      ["navigate", "Host"],
      ["self", "Filter"],
    ],
  );
  assert.deepEqual(items[1], {
    kind: "self",
    title: "Filter",
    picks: { host: ["web-01"] },
  });
  assert.equal(hasDatumLinks(p, targets), true);
  assert.equal(hasDatumLinks(p, {}), true, "the self link is always usable");
  assert.equal(
    hasDatumLinks(
      panel("bar", { links: [link({ set: { host: { column: "host" } } })] }),
      {},
    ),
    false,
  );
  assert.deepEqual(
    menuLinks(p, targets, context).map((i) => i.title),
    ["Panel link"],
  );
});

test("an ECharts click is read defensively", () => {
  assert.deepEqual(
    datumClick({
      seriesName: "cpu",
      dataIndex: 3,
      name: "web",
      event: { event: { clientX: 10, clientY: 20 } },
    }),
    { seriesName: "cpu", dataIndex: 3, name: "web", clientX: 10, clientY: 20 },
  );
  assert.deepEqual(datumClick({ seriesName: 1, dataIndex: "3" }), {
    seriesName: undefined,
    dataIndex: undefined,
    name: undefined,
    clientX: 0,
    clientY: 0,
  });
  assert.equal(datumClick(null), null);
});

test("a click during a brush, or the release that ends one, is not a datum click", () => {
  const now = 10_000;
  assert.equal(isBrushClick({ active: true, endedAt: 0 }, now), true);
  assert.equal(isBrushClick({ active: false, endedAt: now - 100 }, now), true);
  assert.equal(isBrushClick({ active: false, endedAt: now - 1_000 }, now), false);
  assert.equal(isBrushClick({ active: false, endedAt: 0 }, now), false);
});

/* A label of a PromQL series (#388) ---------------------------------------- */

test("a label pick reads one label out of the clicked PromQL series' name", () => {
  const l = link({ set: { host: { label: "instance" }, job: { label: "job" } } });
  const series = 'up{instance="web-01:9100", job="node"}';
  assert.deepEqual(linkPicks(l, { row: { time: 1, [series]: 1 }, series }), {
    host: ["web-01:9100"],
    job: ["node"],
  });
  assert.equal(isDatumLink(l), true);
});

test("a label the series lacks, or a name that is not a series, is left unset", () => {
  const l = link({ set: { host: { label: "instance" } } });
  assert.deepEqual(linkPicks(l, { row: {}, series: '{job="node"}' }), {});
  assert.deepEqual(linkPicks(l, { row: {}, series: "cpu" }), {});
  assert.deepEqual(linkPicks(l, { row: {} }), {});
});

test("a series label's value is read as the JSON string it was written as, never split", () => {
  assert.equal(seriesLabel('{route="/a, b=\\"c\\""}', "route"), '/a, b="c"');
  // A label name inside another label's value is not a label.
  assert.equal(seriesLabel('{route="/a, b=\\"c\\""}', "b"), undefined);
  assert.equal(seriesLabel('{host="a\\"b"}', "host"), 'a"b');
});
