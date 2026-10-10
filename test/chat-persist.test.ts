import { test } from "node:test";
import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import {
  PANEL_UNAVAILABLE,
  persistableMessage,
  readStoredChatMessage,
} from "@/lib/chat/persist";
import { MAX_SAMPLE_ROWS } from "@/lib/chat/panel";

const spec = {
  title: "Requests by service",
  viz: "table",
  query: {
    sourceId: "src-metrics",
    sql: "SELECT service, count(*) AS requests FROM http_requests GROUP BY service",
  },
};

function answer(output: unknown, input: unknown = spec): UIMessage {
  return {
    id: "a1",
    role: "assistant",
    parts: [
      { type: "text", text: "Here are requests by service." },
      {
        type: "tool-showPanel",
        toolCallId: "c1",
        state: "output-available",
        input,
        output,
      },
    ],
  } as unknown as UIMessage;
}

const drawn = {
  ok: true,
  panelId: "p1",
  spec: { ...spec, id: "p1", layout: { x: 0, y: 0, w: 12, h: 4 } },
  columns: ["service", "requests"],
  rows: Array.from({ length: 10_000 }, (_, i) => ({ service: `svc-${i}`, requests: i })),
  rowCount: 10_000,
  window: { from: 0, to: 1 },
};

test("a stored panel keeps its spec and a sample, never the result set", () => {
  const stored = persistableMessage(answer(drawn));
  const json = JSON.stringify(stored);
  assert.ok(json.length < 2_000, `stored message is ${json.length} bytes`);
  assert.doesNotMatch(json, /svc-9999/);

  const part = stored.parts[1] as { input: unknown; output: Record<string, unknown> };
  assert.deepEqual(part.input, spec);
  assert.equal(part.output.panelId, "p1");
  assert.equal(part.output.rowCount, 10_000);
  assert.equal((part.output.sample as unknown[]).length, MAX_SAMPLE_ROWS);
  assert.equal("rows" in part.output, false);
  // The text is untouched.
  assert.deepEqual(stored.parts[0], {
    type: "text",
    text: "Here are requests by service.",
  });
});

test("a stored message reads back with its panel", () => {
  const stored = persistableMessage(answer(drawn));
  const read = readStoredChatMessage({
    createdAt: "2026-10-10T00:00:00.000Z",
    id: stored.id,
    role: stored.role,
    content: JSON.parse(JSON.stringify(stored)),
  });
  assert.ok(read);
  const part = read.parts[1] as { state: string; output: { panelId: string } };
  assert.equal(part.state, "output-available");
  assert.equal(part.output.panelId, "p1");
});

test("a stored panel this build cannot draw reads back as an error, not a gap", () => {
  const stored = persistableMessage(answer(drawn, { ...spec, viz: "no-such-kind" }));
  const read = readStoredChatMessage({
    createdAt: "2026-10-10T00:00:00.000Z",
    id: "a1",
    role: "assistant",
    content: stored,
  });
  assert.ok(read);
  assert.equal(read.parts.length, 2);
  const part = read.parts[1] as { state: string; errorText: string };
  assert.equal(part.state, "output-error");
  assert.equal(part.errorText, PANEL_UNAVAILABLE);
});

test("a stored output is untrusted: rows smuggled into it are cut to the sample", () => {
  const read = readStoredChatMessage({
    createdAt: "2026-10-10T00:00:00.000Z",
    id: "a1",
    role: "assistant",
    content: answer({ ...drawn, sample: drawn.rows }),
  });
  assert.ok(read);
  const part = read.parts[1] as { output: { sample: unknown[] } };
  assert.equal(part.output.sample.length, MAX_SAMPLE_ROWS);
  assert.doesNotMatch(JSON.stringify(read), /svc-9999/);
});

test("a refusal is stored and read back as one", () => {
  const refused = { ok: false, error: "table payroll is not in the catalog" };
  const stored = persistableMessage(answer(refused));
  const read = readStoredChatMessage({
    createdAt: "2026-10-10T00:00:00.000Z",
    id: "a1",
    role: "assistant",
    content: stored,
  });
  const part = read?.parts[1] as { output: unknown };
  assert.deepEqual(part.output, refused);
});
