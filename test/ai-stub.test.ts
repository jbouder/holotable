import assert from "node:assert/strict";
import { test } from "node:test";
import { streamObject, streamText } from "ai";
import {
  recordedDashboard,
  STUB_CHAT_REPLY,
  STUB_PANEL_EDIT_SUFFIX,
  stubModel,
} from "@/lib/ai/stub";
import { DashboardGenerationSchema, ExplorePanel, Panel, queryText } from "@/lib/ir";
import {
  ModelSourceDraft,
  type SqlSourceConfig,
  TimescaleDbConfig,
} from "@/lib/registry";
import { validateSql } from "@/lib/sql/safety";

/*
 * The recorded model behind AI_PROVIDER=stub (#88). What it answers has to
 * pass the same schemas and the same SQL guard a real model's answer does, or
 * the end-to-end suite would be testing a path production never takes.
 */

/** `object` settles only once the stream has been read, as a route reads it. */
async function finalObject<T>(result: {
  partialObjectStream: AsyncIterable<unknown>;
  object: PromiseLike<T>;
}): Promise<T> {
  for await (const _ of result.partialObjectStream) {
    // drain
  }
  return result.object;
}

const SYSTEM = "You design monitoring dashboards.\nsourceId: e2e-metrics\n\nCatalog: ...";

/** The demo schema the recorded SQL is written against (timescaledb/init). */
const DEMO = TimescaleDbConfig.parse({
  host: "localhost",
  port: 5432,
  database: "holotable",
  schema: "metrics",
  tables: [
    {
      name: "http_requests",
      timeField: "ts",
      columns: [
        { name: "ts", type: "timestamp with time zone" },
        { name: "service", type: "text" },
        { name: "route", type: "text" },
        { name: "status", type: "smallint" },
      ],
    },
  ],
});

test("a dashboard request streams the recorded spec, bound to the prompt's source", async () => {
  const result = streamObject({
    model: stubModel(),
    schema: DashboardGenerationSchema,
    schemaName: "Dashboard",
    system: SYSTEM,
    prompt: "Create a dashboard for this request: checkout health",
  });
  const spec = DashboardGenerationSchema.parse(await finalObject(result));
  assert.deepEqual(
    spec,
    DashboardGenerationSchema.parse(recordedDashboard("e2e-metrics")),
  );
  for (const panel of spec.panels) {
    assert.equal(panel.query?.sourceId, "e2e-metrics");
  }
});

test("every recorded statement passes the SQL guard against the demo schema", async () => {
  for (const panel of recordedDashboard("e2e-metrics").panels) {
    const r = await validateSql(queryText(panel.query), DEMO);
    assert.equal(r.ok, true, `${panel.id}: ${r.error}`);
  }
});

test("a panel edit returns the current panel, same id, with the recorded change", async () => {
  const current = Panel.parse(recordedDashboard("e2e-metrics").panels[0]);
  const result = streamObject({
    model: stubModel(),
    schema: Panel,
    schemaName: "Panel",
    system: SYSTEM,
    prompt: `Here is the current panel spec:\n${JSON.stringify(current, null, 2)}\n\nApply this change: rename it`,
  });
  const panel = Panel.parse(await finalObject(result));
  assert.equal(panel.id, current.id);
  assert.equal(panel.title, `${current.title}${STUB_PANEL_EDIT_SUFFIX}`);
  assert.equal(
    panel.query ? queryText(panel.query) : undefined,
    current.query ? queryText(current.query) : undefined,
  );
});

test("an explore question gets the recorded single panel", async () => {
  const result = streamObject({
    model: stubModel(),
    schema: ExplorePanel,
    schemaName: "Panel",
    system: SYSTEM,
    prompt: "Answer this question with a SINGLE panel: which service is busiest?",
  });
  const panel = ExplorePanel.parse(await finalObject(result));
  assert.equal(panel.id, "explore");
  const r = await validateSql(
    (panel.query ? queryText(panel.query) : undefined) ?? "",
    DEMO,
  );
  assert.equal(r.ok, true, r.error);
});

test("a source draft uses a granted ref and placeholders, never a plausible host", async () => {
  const result = streamObject({
    model: stubModel(),
    schema: ModelSourceDraft,
    schemaName: "SourceDraft",
    system: `'secretRef' MUST be one of: "TS_METRICS", "OTHER".`,
    prompt: "Draft a data source for this description: our metrics",
  });
  const draft = ModelSourceDraft.parse(await finalObject(result));
  assert.equal(draft.secretRef, "TS_METRICS");
  assert.equal(draft.config.host, "<host>");
});

test("chat answers with the recorded text", async () => {
  const result = streamText({
    model: stubModel(),
    system: SYSTEM,
    prompt: "what is up?",
  });
  assert.equal(await result.text, STUB_CHAT_REPLY);
});
