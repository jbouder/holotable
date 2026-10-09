import { cannotRun } from "@/lib/sources/registry";
import { toText } from "@/components/charts/options";
import { HttpError } from "@/lib/auth/authorize";
import { getSourceById } from "@/lib/db/repo";
import { VARIABLE_VALUES_MAX, type Variable, isSqlQuery } from "@/lib/ir";
import type { SourceRecord } from "@/lib/registry";
import { type RowScope, rowFilterHttpError, rowFilterInScope } from "@/lib/row-scope";
import type { ExecutablePlan } from "@/lib/sql/safety";
import type { VariableValues } from "@/lib/sql/variables";
import type { QueryResult } from "@/lib/sources/execution";
import { serverKind } from "@/lib/sources/server/registry";
import {
  resolveSelection,
  type Selection,
  type VariableChoice,
  VariableSelectionError,
} from "@/lib/variable-selection";

/**
 * The values a dashboard variable allows (#67), on the server.
 *
 * An `enum` allows the values it lists. A `query` variable allows what its own
 * SELECT returns now, and that SELECT is held to everything a panel's is: the
 * source is re-resolved and must be in the dashboard's workspace (a crafted
 * spec naming another workspace's source gets nothing, not an error that says
 * it exists), the statement passes the guard with no variables of its own,
 * and a row-filtered source returns only the rows the viewer's scope allows.
 * So a viewer cannot pick, and the picker cannot list, a value they could not
 * have read.
 */

export interface VariableDeps {
  getSource: (id: string) => Promise<SourceRecord | null>;
  execute: (source: SourceRecord, plan: ExecutablePlan) => Promise<QueryResult>;
}

const DEFAULT_DEPS: VariableDeps = {
  getSource: getSourceById,
  execute: (source, plan) => serverKind(source).execute(source, plan),
};

/**
 * What a variable allows. A query variable's failure is the author's to fix,
 * and says so; a source that is gone or not the dashboard's is reported the
 * same way as one that never existed.
 */
export async function variableOptions(
  variable: Variable,
  workspaceId: string,
  scope: RowScope,
  deps: VariableDeps = DEFAULT_DEPS,
): Promise<string[]> {
  if (variable.type === "enum" || !variable.query) return [...(variable.values ?? [])];
  const query = variable.query;
  const source = await deps.getSource(query.sourceId);
  if (!source || source.tombstonedAt || source.workspaceId !== workspaceId) {
    throw new VariableSelectionError(
      `variable :${variable.name} reads a source that is not available`,
    );
  }
  if (!isSqlQuery(query)) {
    throw new VariableSelectionError(
      `variable :${variable.name}: ${cannotRun(source, query)}`,
    );
  }
  const { sql } = query;
  const kind = serverKind(source);
  const check = await kind.validate(sql, source.config);
  if (!check.ok) {
    throw new VariableSelectionError(`variable :${variable.name}: ${check.error}`);
  }
  const now = new Date();
  const plan = kind.plan({
    sql,
    from: now,
    to: now,
    rowFilter: rowFilterInScope(source, scope),
  });
  const result = await deps.execute(source, plan);
  const column = result.columns[0];
  if (column === undefined) return [];
  const values = new Set<string>();
  for (const row of result.rows) {
    const text = toText(row[column]);
    if (text !== "" && text.length <= 256) values.add(text);
    if (values.size >= VARIABLE_VALUES_MAX) break;
  }
  return [...values];
}

/**
 * {@link variableOptions} once per variable per request, however many times
 * a resolution asks.
 */
export function cachedOptions(
  workspaceId: string,
  scope: RowScope,
  deps: VariableDeps = DEFAULT_DEPS,
): (variable: Variable) => Promise<string[]> {
  const cache = new Map<string, Promise<string[]>>();
  return (variable) => {
    let hit = cache.get(variable.name);
    if (!hit) {
      hit = variableOptions(variable, workspaceId, scope, deps);
      cache.set(variable.name, hit);
    }
    return hit;
  };
}

/** The sources a dashboard's variables read, for its row scope. */
export function variableSourceIds(variables: readonly Variable[] | undefined): string[] {
  return (variables ?? []).flatMap((v) => (v.query ? [v.query.sourceId] : []));
}

/**
 * The values a request may run with: its `var-*` picks, checked against what
 * each variable allows for this viewer, or each one's default. A value the
 * variable does not allow is a 400 the viewer can act on; a viewer without
 * the row-filter claim a variable's source needs is refused as for a panel.
 */
export async function checkedSelection(
  variables: readonly Variable[] | undefined,
  requested: Selection,
  workspaceId: string,
  scope: RowScope,
  deps: VariableDeps = DEFAULT_DEPS,
): Promise<VariableValues> {
  if (!variables?.length) return {};
  try {
    return await resolveSelection(
      variables,
      requested,
      cachedOptions(workspaceId, scope, deps),
    );
  } catch (err) {
    if (err instanceof VariableSelectionError) {
      throw new HttpError(400, err.message, {}, "validation");
    }
    throw rowFilterHttpError(err);
  }
}

/**
 * What the dashboard page hands its picker: each variable's allowed values for
 * this viewer, and the selection to open on, from the URL when every pick in
 * it is allowed and from the defaults when not. A variable whose query fails
 * offers nothing and says why; the page still renders, and the stream reports
 * the same failure on the dashboard.
 */
export async function variableChoices(
  variables: readonly Variable[] | undefined,
  requested: Selection,
  workspaceId: string,
  scope: RowScope,
  deps: VariableDeps = DEFAULT_DEPS,
): Promise<{ choices: VariableChoice[]; selection: VariableValues }> {
  if (!variables?.length) return { choices: [], selection: {} };
  const options = cachedOptions(workspaceId, scope, deps);
  const choices: VariableChoice[] = [];
  for (const v of variables) {
    const choice: VariableChoice = {
      name: v.name,
      label: v.label ?? v.name,
      multi: v.multi === true,
      options: [],
    };
    try {
      choice.options = await options(v);
    } catch (err) {
      choice.error =
        err instanceof VariableSelectionError
          ? err.message
          : "its values could not be read";
    }
    choices.push(choice);
  }
  const resolve = (picks: Selection) =>
    resolveSelection(variables, picks, (v) => options(v).catch(() => []));
  let selection: VariableValues = {};
  try {
    selection = await resolve(requested);
  } catch {
    selection = await resolve({}).catch(() => ({}));
  }
  return { choices, selection };
}
