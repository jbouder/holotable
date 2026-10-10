import type { ChatExecutor } from "@/lib/ai/data-chat";
import type { SourcePlan } from "@/lib/sources/server/types";
import { type SqlSourceRecord, TimescaleDbConfig } from "@/lib/registry";

/** A TimescaleDB source with one table, for a chat test. */
export function chatSource(
  id: string,
  workspaceId = "ws-1",
  table = "http_requests",
): SqlSourceRecord {
  return {
    id,
    workspaceId,
    name: id,
    kind: "timescaledb",
    config: TimescaleDbConfig.parse({
      host: "postgres",
      port: 5432,
      database: "holotable",
      schema: "metrics",
      ssl: false,
      tables: [
        {
          name: table,
          timeField: "ts",
          columns: [
            { name: "ts", type: "timestamp with time zone" },
            { name: "service", type: "text" },
            { name: "status", type: "smallint" },
            { name: "duration_ms", type: "double precision" },
          ],
        },
      ],
    }),
    secretRef: `TS_${id.toUpperCase().replaceAll("-", "_")}`,
    catalogRefreshedAt: new Date().toISOString(),
    catalogMissingTables: [],
    createdBy: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tombstonedAt: null,
  };
}

/** An executor that records every plan it is handed and answers `rows`. */
export function recordingExecutor(rows: Record<string, unknown>[] = []): {
  execute: ChatExecutor;
  plans: SourcePlan[];
} {
  const plans: SourcePlan[] = [];
  return {
    plans,
    execute: async (_source, plan) => {
      plans.push(plan);
      return { columns: Object.keys(rows[0] ?? {}), rows };
    },
  };
}

/** Call a tool's `execute` as the SDK would, outside a model turn. */
export async function runTool<I, O>(t: object, input: I): Promise<O> {
  const { execute } = t as { execute?: (input: I, options: unknown) => unknown };
  if (!execute) throw new Error("the tool has no execute");
  return (await execute(input, {
    toolCallId: "call-1",
    messages: [],
  })) as O;
}
