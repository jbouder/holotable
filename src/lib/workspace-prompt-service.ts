import { HttpError } from "@/lib/auth/authorize";
import { getSourceById } from "@/lib/db/repo";
import {
  pgWorkspacePromptStore,
  type WorkspacePromptStore,
} from "@/lib/db/workspace-prompts";
import { hasQuery } from "@/lib/ir";
import type { SourceRecord } from "@/lib/registry";
import { validateSql } from "@/lib/sql/safety";
import type { WorkspacePrompt } from "@/lib/workspace-prompt";

/**
 * The server half of prompt customization (#66): holding a few-shot example
 * to the rules before it is saved, and again before it is shown to the model.
 */

/**
 * Refuse a customization whose example panels would teach the model a query
 * the app would not run. Each example's source must exist, be live and be in
 * `workspaceId` (the authorized one from the path, never the example's own
 * claim), and its SQL must pass the guard against that source's catalog. An
 * example declares no dashboard variables, so a `:name` reference is refused
 * too. The IR half was checked by the schema the body was read with.
 */
export async function validateWorkspacePrompt(
  prompt: WorkspacePrompt,
  workspaceId: string,
  // Injectable so the rules can be tested without a database.
  getSource: (id: string) => Promise<SourceRecord | null> = getSourceById,
): Promise<void> {
  for (const [i, example] of prompt.examples.entries()) {
    const label = `example ${i + 1}`;
    if (!hasQuery(example.panel)) {
      throw new HttpError(400, `${label}: an example panel must run a query`);
    }
    const { sourceId, sql } = example.panel.query;
    const source = await getSource(sourceId);
    if (!source || source.tombstonedAt || source.workspaceId !== workspaceId) {
      throw new HttpError(
        400,
        `${label}: source "${sourceId}" is not a data source in this workspace`,
      );
    }
    const check = await validateSql(sql, source.config);
    if (!check.ok) throw new HttpError(400, `${label}: ${check.error}`);
  }
}

/**
 * The customization as the model sees it for a generation over `sources`:
 * an example is kept only when it is for one of them (the prompt carries an
 * example only for its own source), and only while its SQL still passes the
 * guard against that source's catalog as it is now, since a table can go
 * missing after the example was saved.
 */
export async function usableWorkspacePrompt(
  prompt: WorkspacePrompt | null,
  sources: SourceRecord | readonly SourceRecord[],
): Promise<WorkspacePrompt | null> {
  if (!prompt) return null;
  const list: readonly SourceRecord[] = Array.isArray(sources) ? sources : [sources];
  const examples: WorkspacePrompt["examples"] = [];
  for (const example of prompt.examples) {
    if (!hasQuery(example.panel)) continue;
    const source = list.find((s) => s.id === example.panel.query?.sourceId);
    if (!source) continue;
    const check = await validateSql(example.panel.query.sql, source.config);
    if (check.ok) examples.push(example);
  }
  return { ...prompt, examples };
}

/**
 * What a generation against `sources` adds to its prompt, or null for
 * nothing. Every source of one generation is in one workspace, so the first
 * one's workspace is the workspace's.
 */
export async function workspacePromptFor(
  sources: SourceRecord | readonly SourceRecord[],
  store: WorkspacePromptStore = pgWorkspacePromptStore,
): Promise<WorkspacePrompt | null> {
  const list: readonly SourceRecord[] = Array.isArray(sources) ? sources : [sources];
  const [first] = list;
  if (!first) return null;
  const view = await store.get(first.workspaceId);
  return usableWorkspacePrompt(view?.prompt ?? null, list);
}
