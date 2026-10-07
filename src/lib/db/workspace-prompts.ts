import { query } from "@/lib/db/pg";
import { log } from "@/lib/log";
import {
  WorkspacePrompt,
  type WorkspacePrompt as WorkspacePromptValue,
  type WorkspacePromptView,
} from "@/lib/workspace-prompt";

/**
 * `workspace_prompts` rows (#66). The workspace is always the caller's
 * authorized one, from the path or from a trusted source record, and every
 * statement filters on it.
 */

export interface WorkspacePromptStore {
  /** The workspace's customization, or null when it has none. */
  get(workspaceId: string): Promise<WorkspacePromptView | null>;
  /** Replace it. The caller has already validated `prompt`, examples included. */
  save(input: {
    workspaceId: string;
    prompt: WorkspacePromptValue;
    updatedBy: string;
  }): Promise<WorkspacePromptView>;
}

interface Row extends Record<string, unknown> {
  workspace_id: string;
  glossary: string;
  metric_definitions: unknown;
  examples: unknown;
  updated_by: string;
  updated_at: Date;
}

/**
 * A row read back goes through the schema, which also upgrades its example
 * panels to the current IR (#58). One that no longer parses is logged and
 * treated as no customization: generation proceeds on the base prompt rather
 * than failing, and the settings page shows the workspace as empty until an
 * admin saves again.
 */
function toView(row: Row): WorkspacePromptView | null {
  const parsed = WorkspacePrompt.safeParse({
    glossary: row.glossary,
    metricDefinitions: row.metric_definitions,
    examples: row.examples,
  });
  if (!parsed.success) {
    log.warn("workspace_prompt.unreadable", {
      workspaceId: row.workspace_id,
      issues: parsed.error.issues.length,
    });
    return null;
  }
  return {
    workspaceId: row.workspace_id,
    prompt: parsed.data,
    updatedBy: row.updated_by,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export const pgWorkspacePromptStore: WorkspacePromptStore = {
  async get(workspaceId) {
    const rows = await query<Row>(
      `SELECT workspace_id, glossary, metric_definitions, examples, updated_by, updated_at
         FROM workspace_prompts WHERE workspace_id = $1`,
      [workspaceId],
    );
    return rows[0] ? toView(rows[0]) : null;
  },

  async save({ workspaceId, prompt, updatedBy }) {
    const rows = await query<Row>(
      `INSERT INTO workspace_prompts
         (workspace_id, glossary, metric_definitions, examples, updated_by, updated_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, now())
       ON CONFLICT (workspace_id) DO UPDATE SET
         glossary           = EXCLUDED.glossary,
         metric_definitions = EXCLUDED.metric_definitions,
         examples           = EXCLUDED.examples,
         updated_by         = EXCLUDED.updated_by,
         updated_at         = now()
       RETURNING workspace_id, glossary, metric_definitions, examples, updated_by, updated_at`,
      [
        workspaceId,
        prompt.glossary,
        JSON.stringify(prompt.metricDefinitions),
        JSON.stringify(prompt.examples),
        updatedBy,
      ],
    );
    const view = toView(rows[0]);
    if (!view) throw new Error("a saved workspace prompt did not read back");
    return view;
  },
};
