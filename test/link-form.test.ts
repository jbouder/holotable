import { test } from "node:test";
import assert from "node:assert/strict";
import type { Panel, PanelLink } from "@/lib/ir";
import {
  emptyLinkForm,
  formFromLink,
  type LinkForm,
  linkFromForm,
  moveLink,
  undeclaredPicks,
} from "@/lib/link-form";
import { describeLink, diffPanels } from "@/lib/panel-diff";

/** Drilldown, Phase 4 (#374): the inspector's link form and link changes in the diff. */

const HOST = "11111111-1111-4111-8111-111111111111";
const OWN = new Set(["service"]);

function form(patch: Partial<LinkForm>): LinkForm {
  return { ...emptyLinkForm(), ...patch };
}

const save = (f: LinkForm, otherTitles: string[] = []) =>
  linkFromForm(f, { otherTitles, ownVariables: OWN });

test("a form becomes the shortest link that says the same thing", () => {
  const { link, problems } = save(
    form({
      target: { id: HOST, title: "Host detail" },
      title: "  Host detail ",
      set: [
        { name: "host", source: "column", text: "host" },
        { name: "metric", source: "series", text: "ignored" },
        { name: "env", source: "value", text: "prod" },
      ],
    }),
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(link, {
    title: "Host detail",
    dashboard: HOST,
    set: { host: { column: "host" }, metric: { series: true }, env: { value: "prod" } },
  });

  const off = save(
    form({
      target: { id: HOST, title: "H" },
      title: "H",
      carryVariables: false,
      newTab: true,
    }),
  ).link;
  assert.deepEqual(off, {
    title: "H",
    dashboard: HOST,
    carry: { variables: false },
    newTab: true,
  });
});

test("a link round-trips through the form unchanged", () => {
  const links: PanelLink[] = [
    {
      title: "A",
      dashboard: HOST,
      carry: { timeRange: false },
      set: { host: { column: "h" } },
    },
    { title: "B", set: { service: { series: true } } },
    { title: "C", dashboard: HOST, newTab: true },
  ];
  for (const link of links) {
    assert.deepEqual(save(formFromLink(link, "Host")).link, link, link.title);
  }
});

test("a self link with nothing set is refused in the IR's own words", () => {
  const { link, problems } = save(form({ title: "Nowhere" }));
  assert.equal(link, null);
  assert.match(problems.join(), /stays on this dashboard, so it must "set" a variable/);
  const stranger = save(
    form({ title: "X", set: [{ name: "host", source: "value", text: "a" }] }),
  );
  assert.match(
    stranger.problems.join(),
    /sets "host", which this dashboard does not declare/,
  );
});

test("the form's own checks: title, unique title, picks, a target to pick", () => {
  assert.match(save(form({ title: "" })).problems.join(), /Give the link a title/);
  assert.match(
    save(form({ title: "Dup", target: { id: HOST, title: "x" } }), [
      "Dup",
    ]).problems.join(),
    /already titled "Dup"/,
  );
  assert.match(
    save(form({ title: "T", target: { id: "", title: "" } })).problems.join(),
    /Choose the dashboard it leads to/,
  );
  const rows = save(
    form({
      title: "T",
      target: { id: HOST, title: "x" },
      set: [
        { name: "", source: "value", text: "a" },
        { name: "Bad Name", source: "value", text: "a" },
        { name: "host", source: "value", text: "" },
        { name: "host", source: "column", text: "" },
      ],
    }),
  ).problems.join("\n");
  assert.match(rows, /Pick 1: choose a variable/);
  assert.match(rows, /Pick 2: "Bad Name" is not a variable name/);
  assert.match(rows, /Pick 3: enter a value/);
  assert.match(rows, /"host" is set twice/);
  assert.match(rows, /Pick 4: choose a column/);
});

test("a pick the target does not declare is flagged, once its variables are known", () => {
  const f = form({
    set: [
      { name: "host", source: "column", text: "host" },
      { name: "region", source: "value", text: "eu" },
      { name: "", source: "value", text: "" },
    ],
  });
  assert.deepEqual(undeclaredPicks(f, ["host"]), ["region"]);
  assert.deepEqual(undeclaredPicks(f, null), []);
});

test("moveLink reorders and refuses to fall off either end", () => {
  assert.deepEqual(moveLink(["a", "b", "c"], 0, 1), ["b", "a", "c"]);
  assert.deepEqual(moveLink(["a", "b", "c"], 2, 1), ["a", "c", "b"]);
  assert.deepEqual(moveLink(["a", "b"], 0, -1), ["a", "b"]);
  assert.deepEqual(moveLink(["a", "b"], 1, 2), ["a", "b"]);
});

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

const PANEL: Panel = {
  id: "p",
  title: "Hosts",
  viz: "table",
  query: { sourceId: "s", sql: "SELECT host FROM m" },
  layout: { x: 0, y: 0, w: 6, h: 4 },
};

test("a link is described by where it goes and what it sets", () => {
  assert.equal(
    describeLink({
      title: "Host",
      dashboard: HOST,
      set: { host: { column: "host" }, svc: { series: true }, env: { value: "prod" } },
      carry: { timeRange: false },
      newTab: true,
    }),
    'to dashboard 11111111; sets host from column host, svc from the clicked series, env = "prod"; not carrying the time range; in a new tab',
  );
  assert.equal(
    describeLink({ title: "S", set: { a: { value: "b" } } }),
    'to this dashboard; sets a = "b"',
  );
});

test("added, changed and removed links appear in the panel diff by title", () => {
  const before: Panel = {
    ...PANEL,
    links: [
      { title: "Host detail", dashboard: HOST },
      { title: "Gone", dashboard: HOST },
      { title: "Same", set: { a: { value: "1" } } },
    ],
  };
  const after: Panel = {
    ...PANEL,
    links: [
      { title: "Host detail", dashboard: HOST, set: { host: { column: "host" } } },
      { title: "New", dashboard: HOST },
      { title: "Same", set: { a: { value: "1" } } },
    ],
  };
  const diff = diffPanels(before, after);
  const changed = Object.fromEntries(
    diff.fields.filter((f) => f.changed).map((f) => [f.label, [f.before, f.after]]),
  );
  assert.deepEqual(changed, {
    'Link "Host detail"': [
      "to dashboard 11111111",
      "to dashboard 11111111; sets host from column host",
    ],
    'Link "New"': ["none", "to dashboard 11111111"],
    'Link "Gone"': ["to dashboard 11111111", "none"],
  });
  assert.equal(diff.fields.find((f) => f.label === 'Link "Same"')?.changed, false);
  assert.equal(diffPanels(PANEL, PANEL).identical, true);
});

test("while a generation streams, links it has not produced are pending, not removed", () => {
  const before: Panel = { ...PANEL, links: [{ title: "Host", dashboard: HOST }] };
  const { links: _, ...draft } = before;
  const diff = diffPanels(before, draft, { streaming: true });
  const row = diff.fields.find((f) => f.label === 'Link "Host"');
  assert.equal(row?.pending, true);
  assert.equal(row?.changed, false);
});

test("a label pick round-trips and names the label it needs (#388)", () => {
  const link: PanelLink = { title: "Host", set: { host: { label: "instance" } } };
  const form = formFromLink(link);
  assert.deepEqual(form.set, [{ name: "host", source: "label", text: "instance" }]);
  assert.deepEqual(
    linkFromForm(form, { otherTitles: [], ownVariables: new Set(["host"]) }).link,
    link,
  );
  const empty = { ...form, set: [{ name: "host", source: "label" as const, text: "" }] };
  assert.deepEqual(
    linkFromForm(empty, { otherTitles: [], ownVariables: new Set(["host"]) }).problems,
    ["Pick 1: name the label."],
  );
  assert.equal(
    describeLink(link),
    "to this dashboard; sets host from the clicked series' instance label",
  );
});
