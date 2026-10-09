import type { PanelQuery, TimeRange, VariableQuery } from "@/lib/ir";
import type { PromqlPlan } from "@/lib/promql/plan";
import type { AnyPlanView } from "@/lib/query-plan";
import type { SourceConfig, SourceRecord } from "@/lib/registry";
import type { SourceTestResult } from "@/lib/source-test";
import type { QueryResult } from "@/lib/sources/execution";
import type { SourceKindName } from "@/lib/sources/registry";
import type { RowFilterBinding } from "@/lib/sql/row-filter";
import type { ExecutablePlan } from "@/lib/sql/safety";
import type { VariableValues } from "@/lib/sql/variables";

/**
 * What every source kind's server half does (#385), in one shape, so the
 * poller, `/api/query`, `/api/sql/*`, variables, chat and the MCP tools run a
 * panel without knowing its language. Each kind checks the query is in its
 * own language first: a PromQL query against a SQL source, or the reverse,
 * is refused here like a table the source does not have.
 */

/** A guard's verdict, in the shape `validateSql` has always returned. */
export interface QueryCheck {
  ok: boolean;
  error?: string;
  /** Labels the catalog does not list (PromQL); never a refusal. */
  hints?: string[];
}

/** What a kind's planner built, tagged with the language that runs it. */
export type SourcePlan =
  | { language: "sql"; plan: ExecutablePlan }
  | { language: "promql"; plan: PromqlPlan };

export interface PlanInput {
  from: Date;
  to: Date;
  /**
   * The viewer's row filter (#31): the claim value, and the column or label
   * the kind matches it against (`RowFilterBinding.column` is that target).
   */
  rowFilter: RowFilterBinding | null;
  /** Values already checked against what the dashboard allows (#67). */
  variables?: VariableValues;
}

export interface ServerSourceKind {
  kind: SourceKindName;
  /** The guard: a panel's query against the source's catalog. */
  check(
    source: SourceRecord,
    query: PanelQuery,
    declared?: ReadonlySet<string>,
  ): Promise<QueryCheck>;
  /** The guard for a `query` variable's query. */
  checkVariable(source: SourceRecord, query: VariableQuery): Promise<QueryCheck>;
  /** Wrap a checked query with the server's window, limits and rewrites. */
  plan(source: SourceRecord, query: PanelQuery, input: PlanInput): SourcePlan;
  /** Run a plan, bounded in time, rows and bytes. */
  execute(source: SourceRecord, plan: SourcePlan): Promise<QueryResult>;
  /**
   * The values a label-values variable offers (#383), under the viewer's
   * row filter. A SQL variable's values are its query's first column, which
   * `variables.ts` reads through `plan` and `execute` like any panel.
   */
  labelValues(
    source: SourceRecord,
    query: VariableQuery,
    rowFilter: RowFilterBinding | null,
  ): Promise<string[]>;
  /** What the plan dialog shows: what runs, and where each value came from. */
  planView(input: {
    source: SourceRecord;
    query: PanelQuery;
    plan: SourcePlan;
    timeRange: TimeRange;
  }): AnyPlanView;
  /** Connectivity and the catalog's tables or metrics. */
  test(source: SourceRecord): Promise<SourceTestResult>;
  /** The catalog as the chat model is shown it. */
  renderCatalog(source: SourceRecord): string;
  /** The catalog block of the generation prompt. */
  catalogPrompt(source: SourceRecord): string;
  /**
   * What is wrong with a config this server would have to reach, or null:
   * for Prometheus, its URL against `SOURCE_URL_ALLOWLIST`, DNS included.
   * Run when a source is saved; every connection is checked again.
   */
  checkConfig(cfg: SourceConfig): Promise<string | null>;
  /** Why a row filter cannot be saved on this config, or null. */
  rowFilterProblem(cfg: SourceConfig): string | null;
  /** Release what the process holds for a source that is going away. */
  dispose(sourceId: string): Promise<void>;
  /** Release what the process holds for every source of the kind, at shutdown. */
  closeAll(): Promise<void>;
}
