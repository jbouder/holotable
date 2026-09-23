import { test } from "node:test";
import assert from "node:assert/strict";
import type { SourceRecord } from "@/lib/registry";
import {
  type Command,
  commandsFromResults,
  fuzzyScore,
  groupCommands,
  MAX_RECENTS,
  parseRecents,
  PER_SECTION,
  projectSource,
  pushRecent,
  rankCommands,
  scoreCommand,
  SECTIONS,
  STATIC_COMMANDS,
  type SearchResults,
} from "@/lib/command-palette";

function results(overrides: Partial<SearchResults> = {}): SearchResults {
  return { dashboards: [], sources: [], ...overrides };
}

function titles(commands: Command[]): string[] {
  return commands.map((c) => c.title);
}

test("fuzzyScore matches a subsequence and rejects anything else", () => {
  assert.ok(fuzzyScore("dash", "Dashboards") !== null);
  assert.ok(fuzzyScore("dbs", "Dashboards") !== null);
  assert.equal(fuzzyScore("zzz", "Dashboards"), null);
  // Out of order is not a subsequence.
  assert.equal(fuzzyScore("hsad", "Dashboards"), null);
  // An empty query matches everything, which is what fills the list on open.
  assert.equal(fuzzyScore("", "Dashboards"), 0);
  assert.equal(fuzzyScore("   ", "Dashboards"), 0);
});

test("fuzzyScore prefers the start, word boundaries and consecutive runs", () => {
  const prefix = fuzzyScore("api", "API latency");
  const scattered = fuzzyScore("api", "Alerts per incident");
  assert.ok(prefix !== null && scattered !== null);
  assert.ok(prefix > scattered);

  const boundary = fuzzyScore("lat", "API latency");
  const inside = fuzzyScore("lat", "Consolidated");
  assert.ok(boundary !== null && inside !== null);
  assert.ok(boundary > inside);

  // Among equal matches the shorter title wins.
  const short = fuzzyScore("err", "Errors");
  const long = fuzzyScore("err", "Errors by service and region over time");
  assert.ok(short !== null && long !== null);
  assert.ok(short > long);
});

test("the keywords match, but count for less than the title", () => {
  const command: Command = {
    id: "action:new-dashboard",
    kind: "action",
    title: "New dashboard",
    keywords: "create add generate",
    action: { type: "navigate", href: "/dashboards/new" },
  };
  // "create" appears only in the keywords, so it still matches.
  assert.ok(scoreCommand(command, "create") !== null);
  // …but less well than the thing it is actually called.
  const byKeyword = scoreCommand(command, "create");
  const byTitle = scoreCommand(command, "new dash");
  assert.ok(byKeyword !== null && byTitle !== null);
  assert.ok(byTitle > byKeyword);
  assert.equal(scoreCommand(command, "zzzz"), null);
});

test("a dashboard becomes one command; a manageable source becomes two", () => {
  const commands = commandsFromResults(
    results({
      dashboards: [{ id: "d1", title: "API latency", workspaceId: "prod" }],
      sources: [
        { id: "s1", name: "metrics", workspaceId: "prod", canManage: true },
        { id: "s2", name: "logs", workspaceId: "prod", canManage: false },
      ],
    }),
  );
  assert.deepEqual(titles(commands), [
    "API latency",
    "metrics",
    "Refresh catalog for metrics",
    "logs",
  ]);
  assert.deepEqual(commands[0].action, { type: "navigate", href: "/dashboards/d1" });
  assert.deepEqual(commands[1].action, {
    type: "navigate",
    href: "/data-sources#source-s1",
  });
  assert.deepEqual(commands[2].action, {
    type: "refresh-catalog",
    sourceId: "s1",
    name: "metrics",
  });
});

test("a source the caller cannot manage is never offered a refresh", () => {
  const commands = commandsFromResults(
    results({
      sources: [{ id: "s2", name: "logs", workspaceId: "prod", canManage: false }],
    }),
  );
  assert.equal(
    commands.some((c) => c.action.type === "refresh-catalog"),
    false,
  );
});

test("with nothing typed, recents lead and the rest keep their declared order", () => {
  const ranked = rankCommands(STATIC_COMMANDS, "", ["action:new-source"]);
  assert.equal(ranked[0].id, "action:new-source");
  assert.deepEqual(
    ranked.slice(1).map((c) => c.id),
    STATIC_COMMANDS.filter((c) => c.id !== "action:new-source").map((c) => c.id),
  );
});

test("a remembered id that names nothing is simply ignored", () => {
  const ranked = rankCommands(STATIC_COMMANDS, "", ["dashboard:deleted-long-ago"]);
  assert.deepEqual(
    ranked.map((c) => c.id),
    STATIC_COMMANDS.map((c) => c.id),
  );
});

test("with something typed the score decides; recency only breaks ties", () => {
  const commands = [
    ...commandsFromResults(
      results({
        dashboards: [
          { id: "d1", title: "API latency", workspaceId: "prod" },
          { id: "d2", title: "Alerts per incident", workspaceId: "prod" },
        ],
      }),
    ),
    ...STATIC_COMMANDS,
  ];
  // "api" spelled out beats a dashboard that was opened yesterday.
  const ranked = rankCommands(commands, "api", ["dashboard:d2"]);
  assert.equal(ranked[0].title, "API latency");

  // With no query to separate them, the recent one leads.
  const idle = rankCommands(commands, "", ["dashboard:d2"]);
  assert.equal(idle[0].title, "Alerts per incident");
});

test("no section can bury the others", () => {
  const many = Array.from({ length: PER_SECTION + 4 }, (_, i) => ({
    id: `d${i}`,
    title: `Dashboard ${i}`,
    workspaceId: "prod",
  }));
  const ranked = rankCommands(
    [...commandsFromResults(results({ dashboards: many })), ...STATIC_COMMANDS],
    "",
  );
  assert.equal(ranked.filter((c) => c.kind === "dashboard").length, PER_SECTION);
  assert.ok(ranked.some((c) => c.kind === "page"));
});

test("grouping fixes the section order without reordering within one", () => {
  const ranked = rankCommands(
    [
      ...commandsFromResults(
        results({
          dashboards: [{ id: "d1", title: "API latency", workspaceId: "prod" }],
          sources: [{ id: "s1", name: "metrics", workspaceId: "prod", canManage: false }],
        }),
      ),
      ...STATIC_COMMANDS,
    ],
    "",
  );
  const grouped = groupCommands(ranked);
  assert.deepEqual(
    grouped.map((g) => g.kind),
    SECTIONS.map((s) => s.kind),
  );
  // Nothing was dropped, and an empty section is left out rather than rendered.
  assert.equal(
    grouped.reduce((n, g) => n + g.commands.length, 0),
    ranked.length,
  );
  assert.equal(groupCommands([]).length, 0);
});

test("pushRecent is most-recent-first, deduplicated and bounded", () => {
  let recents: string[] = [];
  for (const id of ["a", "b", "c", "d", "e", "f"]) recents = pushRecent(recents, id);
  assert.deepEqual(recents, ["f", "e", "d", "c", "b"]);
  assert.equal(recents.length, MAX_RECENTS);
  assert.deepEqual(pushRecent(["a", "b", "c"], "c"), ["c", "a", "b"]);
});

test("recents from storage are treated as untrusted", () => {
  assert.deepEqual(parseRecents(null), []);
  assert.deepEqual(parseRecents("not json"), []);
  assert.deepEqual(parseRecents('{"a":1}'), []);
  assert.deepEqual(parseRecents('["a",1,null,"b"]'), ["a", "b"]);
  assert.deepEqual(parseRecents(`["${"x".repeat(500)}"]`), []);
  assert.equal(parseRecents(JSON.stringify(Array(50).fill("a"))).length, MAX_RECENTS);
});

test("every static command is an ordinary route, never a privileged one", () => {
  for (const command of STATIC_COMMANDS) {
    if (command.action.type !== "navigate") continue;
    assert.ok(
      command.action.href.startsWith("/"),
      `${command.id} must be a same-origin path`,
    );
    assert.ok(
      !command.action.href.startsWith("/api/"),
      `${command.id} must not point at an API route`,
    );
  }
});

test("a search result carries a source's name and nothing else about it", () => {
  // Deliberately leaky: every field here except the four projected ones is
  // something invariant 5 keeps out of a client payload.
  const source: SourceRecord = {
    id: "s1",
    workspaceId: "prod",
    name: "metrics",
    kind: "timescaledb",
    config: {
      host: "db.internal.example",
      port: 5432,
      database: "metrics",
      ssl: true,
      schema: "public",
      tables: [
        { name: "cpu", timeField: "ts", columns: [{ name: "ts", type: "timestamptz" }] },
      ],
    },
    secretRef: "vault://prod/metrics#password",
    catalogRefreshedAt: "2026-09-22T00:00:00Z",
    catalogMissingTables: ["gone"],
    createdBy: "someone",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-02T00:00:00Z",
    tombstonedAt: null,
  };

  const projected = projectSource(source, true);
  assert.deepEqual(projected, {
    id: "s1",
    name: "metrics",
    workspaceId: "prod",
    canManage: true,
  });

  const serialized = JSON.stringify(projected);
  for (const secret of [
    "db.internal.example",
    "5432",
    "vault://",
    "public",
    "cpu",
    "gone",
  ]) {
    assert.ok(!serialized.includes(secret), `leaked ${secret}`);
  }
});
