import { fenceUntrustedBlock, sanitizePromptField } from "@/lib/ai/untrusted";
import {
  Dashboard,
  declaredVariables,
  hasQuery,
  isSqlQuery,
  Panel,
  PromqlQuery,
  queryTimeField,
  SqlQuery,
} from "@/lib/ir";
import type { VariableValues } from "@/lib/sql/variables";
import { defaultValue } from "@/lib/variable-selection";

/**
 * A dashboard as chat prompt context (#366, #416): its panels, its variables
 * and what they are bound to, and the panel the reader asked about. The
 * dashboard chat and a Chat conversation that continues it both put these
 * in their prompts, fenced as the untrusted text they are.
 */

/**
 * What the reader has on screen when they ask (#366): the dashboard's own
 * range or the one they picked, their variable picks, and the panel they
 * asked about. The range is part of the dashboard handed to the turn; this is
 * the rest.
 */
export interface ChatView {
  /** The values every query this turn binds, already checked. */
  variables: VariableValues;
  /**
   * The reader picked values this server would not bind for them, so the
   * defaults were used instead. The prompt says so, and so does the answer.
   */
  picksRefused: boolean;
  /** The panel the reader asked about, when it is on this dashboard. */
  focusPanelId?: string;
}

/** How long one variable value may be in the prompt: the IR's own cap. */
const VARIABLE_VALUE_MAX = 256;

/**
 * The variables a query may reference (#67), and what they are bound to this
 * turn (#366). The names are held to `[a-z][a-z0-9_]*` by the IR; the values
 * came out of a variable's list or its query's rows, so they are untrusted
 * text and go in a fence. They are shown so the answer can say which slice it
 * describes; the server still binds them as parameters, never as text.
 */
export function variablesBlock(dashboard: Dashboard, view: ChatView | undefined): string {
  const names = [...declaredVariables(dashboard)];
  if (names.length === 0) return "";
  if (!view) {
    return `\nVariables a query may reference as :name, bound to their defaults: ${names.join(", ")}`;
  }
  const lines = names.map((name) => {
    const value = view.variables[name];
    const shown =
      value === undefined
        ? "(no value)"
        : [value]
            .flat()
            .map((v) => sanitizePromptField(v, VARIABLE_VALUE_MAX))
            .join(", ") || "(none)";
    return `${name} = ${shown}`;
  });
  const whose = view.picksRefused
    ? "bound to their DEFAULTS, because the reader's own picks are not values they may use; say so if it matters to the answer"
    : "bound to the values the reader has picked";
  return `\nVariables a query may reference as :name, ${whose}:\n${fenceUntrustedBlock("VARIABLES", lines.join("\n"))}`;
}

/** The panel the reader asked about (#366), as a prompt line, or nothing. */
export function focusLine(dashboard: Dashboard, view: ChatView | undefined): string {
  const panel = dashboard.panels.find((p) => p.id === view?.focusPanelId);
  if (!panel) return "";
  const f = sanitizePromptField;
  return `\nThe reader is asking about panel "${f(panel.id, PANEL_MAX.id)}" (${f(panel.title, PANEL_MAX.title)}). Answer about that panel unless the question is plainly about something else.`;
}

/** The values a chat query binds: defaults, or a list's first value. */
export function chatVariableValues(dashboard: Dashboard): VariableValues {
  const values: Record<string, VariableValues[string]> = {};
  for (const v of dashboard.variables ?? []) {
    const value = defaultValue(v, v.values ?? []);
    if (value !== undefined) values[v.name] = value;
  }
  return values;
}

// Prompt clamps for stored panel fields: the IR schema's own maxima, read from
// the schema so a spec can never grow in the prompt.
export const PANEL_MAX = {
  id: Panel.shape.id.maxLength ?? 64,
  title: Panel.shape.title.maxLength ?? 200,
  description: Panel.shape.description.unwrap().maxLength ?? 500,
  sourceId: SqlQuery.shape.sourceId.maxLength ?? 128,
  sql: SqlQuery.shape.sql.maxLength ?? 8_000,
  promql: PromqlQuery.shape.promql.maxLength ?? 8_000,
  timeField: SqlQuery.shape.timeField.unwrap().maxLength ?? 128,
  /** A text panel's Markdown is context, not the point: a short excerpt. */
  content: 500,
  dashboardTitle: Dashboard.shape.title.maxLength ?? 200,
} as const;

/**
 * The stored panel specs as prompt lines. A spec was written by an earlier
 * model run from a user prompt, so its titles, descriptions and SQL are
 * untrusted text in this prompt exactly like catalog metadata: every field is
 * flattened onto one line and clamped. Exported for testing.
 */
export function renderPanels(dashboard: Dashboard): string {
  const f = sanitizePromptField;
  return dashboard.panels
    .map((p) => {
      const head = `- panel "${f(p.id, PANEL_MAX.id)}" — ${f(p.title, PANEL_MAX.title)}`;
      if (!hasQuery(p)) {
        // A text panel (#202): no query to cite, and its prose is as
        // untrusted as any other stored field.
        const content = typeof p.options?.content === "string" ? p.options.content : "";
        return [
          `${head} (viz: ${p.viz}, runs no query)`,
          `    text: ${f(content, PANEL_MAX.content)}`,
        ].join("\n");
      }
      const lines = [
        `${head} (viz: ${p.viz}, source: ${f(p.query.sourceId, PANEL_MAX.sourceId)})`,
      ];
      if (p.description)
        lines.push(`    intent: ${f(p.description, PANEL_MAX.description)}`);
      const timeField = queryTimeField(p.query);
      if (timeField) lines.push(`    timeField: ${f(timeField, PANEL_MAX.timeField)}`);
      lines.push(
        isSqlQuery(p.query)
          ? `    sql: ${f(p.query.sql, PANEL_MAX.sql)}`
          : `    promql: ${f(p.query.promql, PANEL_MAX.promql)}`,
      );
      return lines.join("\n");
    })
    .join("\n");
}
