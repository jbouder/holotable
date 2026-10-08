import { test } from "node:test";
import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import type { Dashboard, Panel } from "@/lib/ir";
import {
  chatSuggestions,
  chatViewFromSearch,
  citationsFromMessage,
  matchingPanels,
  MAX_SUGGESTIONS,
  messagesToPersist,
  parseStoredMessage,
  panelChatSuggestions,
  parseStoredMessages,
  type StoredChatMessage,
} from "@/lib/chat-history";
import { queryOf } from "./support/panels";

function panel(overrides: Partial<Panel> = {}): Panel {
  return {
    id: "p1",
    title: "Requests",
    viz: "line",
    query: {
      sourceId: "src-1",
      sql: "SELECT ts, count(*) FROM http_requests GROUP BY ts",
      timeField: "ts",
    },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    ...overrides,
  };
}

function dashboard(panels: Panel[]): Dashboard {
  return {
    specVersion: 1,
    title: "Service health",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 15_000,
    panels,
  };
}

function row(overrides: Partial<StoredChatMessage> = {}): StoredChatMessage {
  return {
    id: "m1",
    role: "assistant",
    content: { id: "m1", role: "assistant", parts: [{ type: "text", text: "hi" }] },
    createdAt: "2026-09-22T10:00:00Z",
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Stored messages                                                            */
/* -------------------------------------------------------------------------- */

test("a stored row becomes a message, with the row's own id and role winning", () => {
  const parsed = parseStoredMessage(
    row({
      id: "m9",
      role: "user",
      // The column is the truth; a disagreeing copy inside the blob is not.
      content: { id: "stale", role: "assistant", parts: [{ type: "text", text: "q" }] },
    }),
  );
  assert.ok(parsed);
  assert.equal(parsed.id, "m9");
  assert.equal(parsed.role, "user");
  assert.equal(parsed.parts.length, 1);
});

test("a row that is not a message is dropped, never repaired", () => {
  assert.equal(parseStoredMessage(row({ content: null })), null);
  assert.equal(parseStoredMessage(row({ content: "a string" })), null);
  assert.equal(parseStoredMessage(row({ content: { parts: "not an array" } })), null);
  assert.equal(parseStoredMessage(row({ content: {} })), null);
  assert.equal(
    parseStoredMessage(row({ role: "tool" as StoredChatMessage["role"] })),
    null,
  );
});

test("parsing a conversation keeps the usable rows in order", () => {
  const messages = parseStoredMessages([
    row({ id: "a", role: "user" }),
    row({ id: "b", content: { parts: "broken" } }),
    row({ id: "c" }),
  ]);
  assert.deepEqual(
    messages.map((m) => m.id),
    ["a", "c"],
  );
});

test("only the tail a turn produced is written back", () => {
  const messages = [
    { id: "a", role: "user", parts: [{ type: "text", text: "q" }] },
    { id: "b", role: "assistant", parts: [{ type: "text", text: "a" }] },
    { id: "c", role: "user", parts: [{ type: "text", text: "q2" }] },
    // Never started — nothing to remember.
    { id: "d", role: "assistant", parts: [] },
  ] as unknown as UIMessage[];

  assert.deepEqual(
    messagesToPersist(messages, ["a", "b"]).map((m) => m.id),
    ["c"],
  );
  assert.deepEqual(
    messagesToPersist(messages, []).map((m) => m.id),
    ["a", "b", "c"],
  );
});

/* -------------------------------------------------------------------------- */
/* Citations                                                                  */
/* -------------------------------------------------------------------------- */

test("a query is cited to the panels that run exactly it", () => {
  const panels = [
    panel(),
    panel({
      id: "p2",
      title: "Errors",
      query: {
        sourceId: "src-1",
        sql: "SELECT ts, count(*) FROM errors",
        timeField: "ts",
      },
    }),
  ];
  // Whitespace, case and a trailing semicolon are not differences.
  assert.deepEqual(
    matchingPanels(
      panels,
      "src-1",
      "select ts,   COUNT(*)\nfrom http_requests group by ts;",
    ),
    ["Requests"],
  );
  // Same source, different statement: the model composed this one itself.
  assert.deepEqual(
    matchingPanels(panels, "src-1", "SELECT max(x) FROM http_requests"),
    [],
  );
  // Same statement, different source.
  assert.deepEqual(matchingPanels(panels, "src-2", queryOf(panels[0]).sql), []);
});

test("citations are read off the message's own tool parts", () => {
  const message = {
    parts: [
      { type: "text", text: "Here you go." },
      {
        type: "tool-runQuery",
        state: "output-available",
        input: { sourceId: "src-1", sql: "SELECT max(v) FROM cpu" },
      },
    ],
  } as unknown as UIMessage;

  assert.deepEqual(citationsFromMessage(message, [panel()]), [
    { sourceId: "src-1", sql: "SELECT max(v) FROM cpu", panelTitles: [] },
  ]);
});

test("a tool call with nothing to cite is skipped rather than shown empty", () => {
  const message = {
    parts: [
      // Stopped mid-stream: the input never arrived.
      { type: "tool-runQuery", state: "input-streaming" },
      { type: "tool-runQuery", state: "input-available", input: null },
      { type: "tool-runQuery", state: "input-available", input: { sourceId: "src-1" } },
      {
        type: "tool-runQuery",
        state: "input-available",
        input: { sourceId: "src-1", sql: "   " },
      },
    ],
  } as unknown as UIMessage;
  assert.deepEqual(citationsFromMessage(message, [panel()]), []);
});

test("a message that ran several queries cites each of them", () => {
  const message = {
    parts: [
      {
        type: "tool-runQuery",
        state: "output-available",
        input: { sourceId: "src-1", sql: queryOf(panel()).sql },
      },
      {
        type: "tool-runQuery",
        state: "output-available",
        input: { sourceId: "src-1", sql: "SELECT min(v) FROM cpu" },
      },
    ],
  } as unknown as UIMessage;
  const citations = citationsFromMessage(message, [panel()]);
  assert.equal(citations.length, 2);
  assert.deepEqual(citations[0].panelTitles, ["Requests"]);
  assert.deepEqual(citations[1].panelTitles, []);
});

/* -------------------------------------------------------------------------- */
/* Suggestions                                                                */
/* -------------------------------------------------------------------------- */

test("suggestions are derived from the spec and bounded", () => {
  const suggestions = chatSuggestions(
    dashboard([
      panel(),
      panel({ id: "p2", title: "Error rate", viz: "stat" }),
      panel({ id: "p3", title: "p99 latency", viz: "area" }),
    ]),
  );
  assert.ok(suggestions.length > 0);
  assert.ok(suggestions.length <= MAX_SUGGESTIONS);
  // The vocabulary is the author's, not a generic list.
  assert.ok(suggestions.some((s) => s.includes("Requests") || s.includes("Error rate")));
  // Every chip is a question a person could actually send.
  for (const s of suggestions) assert.ok(s.trim().length > 0);
});

test("a one-panel dashboard still gets distinct suggestions", () => {
  const suggestions = chatSuggestions(dashboard([panel({ viz: "table" })]));
  assert.equal(new Set(suggestions).size, suggestions.length);
  assert.ok(suggestions.length >= 1);
});

test("an absurd panel title is left out of the chips rather than truncated into one", () => {
  const long = "x".repeat(200);
  for (const viz of ["bar", "stat", "line", "table"] as const) {
    const suggestions = chatSuggestions(dashboard([panel({ viz, title: long })]));
    assert.ok(
      !suggestions.some((s) => s.includes("x".repeat(61))),
      `${viz} leaked a 200-character title`,
    );
  }
});

test("suggestions are deterministic — the same spec gives the same chips", () => {
  const spec = dashboard([panel(), panel({ id: "p2", title: "Errors", viz: "stat" })]);
  assert.deepEqual(chatSuggestions(spec), chatSuggestions(spec));
});

/* The reader's view, and questions about one panel (#366) ----------------- */

test("a citation says which window and values the server narrowed the rows to", () => {
  const message = {
    parts: [
      {
        type: "tool-runQuery",
        state: "output-available",
        input: { sourceId: "src-1", sql: "SELECT max(v) FROM cpu" },
        output: {
          columns: [],
          rows: [],
          timeRange: { from: "now-7d", to: "now" },
          variables: { host: ["a", "b"], region: "eu" },
        },
      },
    ],
  } as unknown as UIMessage;

  assert.deepEqual(citationsFromMessage(message, [panel()]), [
    {
      sourceId: "src-1",
      sql: "SELECT max(v) FROM cpu",
      panelTitles: [],
      timeRange: { from: "now-7d", to: "now" },
      variables: { host: ["a", "b"], region: ["eu"] },
    },
  ]);
});

test("a failed query's output adds no window to its citation", () => {
  const message = {
    parts: [
      {
        type: "tool-runQuery",
        state: "output-available",
        input: { sourceId: "src-1", sql: "SELECT 1" },
        output: { error: "bad" },
      },
    ],
  } as unknown as UIMessage;
  const [citation] = citationsFromMessage(message, []);
  assert.equal(citation.timeRange, undefined);
  assert.equal(citation.variables, undefined);
});

test("the view is read from the dashboard's URL: range when set, and every pick", () => {
  assert.deepEqual(chatViewFromSearch("?from=now-7d&to=now&var-host=a&var-host=b"), {
    timeRange: { from: "now-7d", to: "now" },
    variables: { host: ["a", "b"] },
  });
  // No range in the URL is the dashboard's own range: the server's default.
  assert.deepEqual(chatViewFromSearch(""), { variables: {} });
  // Half a range is no range; the server would refuse it anyway.
  assert.deepEqual(chatViewFromSearch("?from=now-7d"), { variables: {} });
});

test("questions about one panel name it, and fit what it draws", () => {
  const line = panelChatSuggestions(panel());
  assert.ok(line.length >= 2 && line.length <= MAX_SUGGESTIONS);
  assert.ok(line.every((q) => q.includes('"Requests"')));
  assert.ok(line.some((q) => /changed over this window/.test(q)));

  const stat = panelChatSuggestions(panel({ viz: "stat", title: "Errors" }));
  assert.ok(stat.some((q) => /behind the "Errors" number/.test(q)));

  const long = panelChatSuggestions(panel({ title: "x".repeat(120) }));
  assert.ok(long.every((q) => q.includes("this panel")));
});
