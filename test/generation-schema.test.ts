import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { recordedDashboard } from "@/lib/ai/stub";
import { DashboardGenerationSchema, ExplorePanel, GeneratedPanel, Panel } from "@/lib/ir";
import { PANEL_KINDS } from "@/lib/panels/registry";

/*
 * The schema the model is bound to (#335). The stored `Panel` says which kinds
 * need a query in a refinement, which JSON Schema cannot carry; the generation
 * schemas say it in their shape, so a model following its schema writes a
 * query for every panel that runs one.
 */

interface JsonObject {
  required?: string[];
  properties: Record<string, { enum?: string[] }>;
  oneOf?: JsonObject[];
  anyOf?: JsonObject[];
}

const json = (schema: z.ZodType) => z.toJSONSchema(schema, { io: "input" }) as JsonObject;

/** The JSON Schema variant for each viz kind. */
function variantsByKind(schema: JsonObject): Map<string, JsonObject> {
  const byKind = new Map<string, JsonObject>();
  for (const variant of schema.oneOf ?? schema.anyOf ?? [schema]) {
    for (const kind of variant.properties.viz.enum ?? []) byKind.set(kind, variant);
  }
  return byKind;
}

test("the generated panel requires query exactly for the kinds that run one", () => {
  const byKind = variantsByKind(json(GeneratedPanel));
  assert.equal(byKind.size, PANEL_KINDS.length, "every kind is offered once");
  for (const kind of PANEL_KINDS) {
    const variant = byKind.get(kind.kind);
    assert.ok(variant, kind.kind);
    if (kind.query === "required") {
      assert.ok(variant.required?.includes("query"), `${kind.kind} must require query`);
    } else {
      assert.ok(!("query" in variant.properties), `${kind.kind} must not offer query`);
    }
  }
});

test("a dashboard's panels are generated panels", () => {
  const schema = json(DashboardGenerationSchema) as JsonObject & {
    properties: { panels: { items: JsonObject } };
  };
  const byKind = variantsByKind(schema.properties.panels.items);
  for (const kind of PANEL_KINDS.filter((k) => k.query === "required")) {
    assert.ok(byKind.get(kind.kind)?.required?.includes("query"), kind.kind);
  }
});

test("explore offers only kinds that run a query, and requires it", () => {
  const schema = json(ExplorePanel);
  assert.ok(schema.required?.includes("query"));
  const offered = new Set(schema.properties.viz.enum);
  for (const kind of PANEL_KINDS) {
    assert.equal(offered.has(kind.kind), kind.query === "required", kind.kind);
  }
});

test("a panel without its query is refused, naming the field", () => {
  const spec = recordedDashboard("s") as { panels: Array<Record<string, unknown>> };
  delete spec.panels[0].query;
  const result = DashboardGenerationSchema.safeParse(spec);
  assert.equal(result.success, false);
  assert.ok(result.error?.issues.some((i) => i.path.join(".") === "panels.0.query"));
});

test("an unknown viz is refused at panels.N.viz, listing the kinds", () => {
  const spec = recordedDashboard("s") as { panels: Array<Record<string, unknown>> };
  spec.panels[0].viz = "sparkle";
  const issue = DashboardGenerationSchema.safeParse(spec).error?.issues[0];
  assert.equal(issue?.path.join("."), "panels.0.viz");
  assert.match(issue?.message ?? "", /'line'/);
});

test("whatever generation accepts, the stored IR accepts", () => {
  const text = {
    id: "note",
    title: "Read me",
    viz: "text",
    options: { content: "**Runbook:** check the error budget first." },
    layout: { x: 0, y: 0, w: 4, h: 2 },
  };
  const spec = recordedDashboard("s") as { panels: unknown[] };
  spec.panels.push(text);
  const generated = DashboardGenerationSchema.parse(spec);
  for (const panel of generated.panels) Panel.parse(panel);
  // A text panel cannot carry what only a query would use.
  assert.equal(
    GeneratedPanel.safeParse({ ...text, query: { sourceId: "s", sql: "SELECT 1" } })
      .success,
    false,
  );
  assert.equal(
    GeneratedPanel.safeParse({ ...text, refreshIntervalMs: 5000 }).success,
    false,
  );
});
