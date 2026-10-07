import { z } from "zod";
import { hasQuery, Panel, SPEC_VERSION } from "@/lib/ir";
import { migratePanel } from "@/lib/ir/upgrade";

/**
 * Per-workspace prompt customization (#66): what a workspace's admins tell the
 * model about their data that the catalog cannot: the team's vocabulary, how
 * a metric is defined, and a few example panels for requests they make often.
 *
 * Every field is capped here, and the caps are what bound the prompt: the
 * largest customization this schema accepts adds at most
 * {@link MAX_WORKSPACE_CONTEXT_CHARS} to a generation's system prompt
 * (`src/lib/ai/prompt.ts` clamps to it as well). The text is written by a
 * source-admin, but it is still not an instruction channel: it is rendered
 * inside a fenced block that cannot override the SQL or security rules.
 *
 * Browser-safe: the settings form validates with the same schema the route
 * does. Checking an example's SQL against its source is server-side, in
 * `src/lib/workspace-prompt-service.ts`.
 */

export const PROMPT_LIMITS = {
  glossary: 2_000,
  metricDefinitions: 15,
  metricName: 48,
  metricDefinition: 200,
  examples: 4,
  examplePrompt: 300,
  /** The example panel, as the JSON the prompt carries. */
  examplePanel: 1_800,
} as const;

/**
 * The most a customization can add to a system prompt: every field at its
 * cap, plus the section headings and per-entry punctuation around them.
 */
export const MAX_WORKSPACE_CONTEXT_CHARS =
  PROMPT_LIMITS.glossary +
  PROMPT_LIMITS.metricDefinitions *
    (PROMPT_LIMITS.metricName + PROMPT_LIMITS.metricDefinition + 8) +
  PROMPT_LIMITS.examples *
    (PROMPT_LIMITS.examplePrompt + PROMPT_LIMITS.examplePanel + 32) +
  200;

export const MetricDefinition = z.strictObject({
  name: z.string().trim().min(1, "name the metric").max(PROMPT_LIMITS.metricName),
  definition: z
    .string()
    .trim()
    .min(1, "define the metric")
    .max(PROMPT_LIMITS.metricDefinition),
});
export type MetricDefinition = z.infer<typeof MetricDefinition>;

const ExampleShape = z
  .strictObject({
    prompt: z
      .string()
      .trim()
      .min(1, "write the request this example answers")
      .max(PROMPT_LIMITS.examplePrompt),
    /** A lone panel records the IR version it was saved at, as a panel template does. */
    specVersion: z.literal(SPEC_VERSION),
    panel: Panel,
  })
  .refine((e) => hasQuery(e.panel), {
    message: "an example panel must run a query",
    path: ["panel"],
  })
  .refine((e) => JSON.stringify(e.panel).length <= PROMPT_LIMITS.examplePanel, {
    message: `an example panel must be at most ${PROMPT_LIMITS.examplePanel} characters of JSON`,
    path: ["panel"],
  });

/**
 * A stored example is brought up to the current IR version before it is
 * validated, so one saved before a breaking IR change still loads (#58).
 */
function upgradeExample(input: unknown, ctx: z.RefinementCtx): unknown {
  if (typeof input !== "object" || input === null) return input;
  const example = input as Record<string, unknown>;
  const migrated = migratePanel(example.panel, example.specVersion);
  if (!migrated.ok) {
    ctx.addIssue({ code: "custom", message: migrated.error });
    return z.NEVER;
  }
  return { ...example, specVersion: SPEC_VERSION, panel: migrated.spec };
}

/** A few-shot example: a request and the panel that answers it. */
export const PromptExample = z.preprocess(upgradeExample, ExampleShape);
export type PromptExample = z.infer<typeof PromptExample>;

export const WorkspacePrompt = z.strictObject({
  glossary: z.string().trim().max(PROMPT_LIMITS.glossary),
  metricDefinitions: z.array(MetricDefinition).max(PROMPT_LIMITS.metricDefinitions),
  examples: z.array(PromptExample).max(PROMPT_LIMITS.examples),
});
export type WorkspacePrompt = z.infer<typeof WorkspacePrompt>;

export const EMPTY_WORKSPACE_PROMPT: WorkspacePrompt = {
  glossary: "",
  metricDefinitions: [],
  examples: [],
};

/** Whether a customization would add anything to a prompt. */
export function isEmptyWorkspacePrompt(prompt: WorkspacePrompt): boolean {
  return (
    prompt.glossary === "" &&
    prompt.metricDefinitions.length === 0 &&
    prompt.examples.length === 0
  );
}

/** What the settings page and `GET /api/workspaces/[id]/prompt` show. */
export interface WorkspacePromptView {
  workspaceId: string;
  prompt: WorkspacePrompt;
  updatedBy: string | null;
  updatedAt: string | null;
}

/**
 * The settings form's working copy: an example's panel is edited as JSON
 * text, so a half-typed panel is a draft rather than a schema error.
 */
export interface WorkspacePromptDraft {
  glossary: string;
  metricDefinitions: MetricDefinition[];
  examples: Array<{ prompt: string; panelJson: string }>;
}

export function draftFromPrompt(prompt: WorkspacePrompt): WorkspacePromptDraft {
  return {
    glossary: prompt.glossary,
    metricDefinitions: prompt.metricDefinitions.map((m) => ({ ...m })),
    examples: prompt.examples.map((e) => ({
      prompt: e.prompt,
      panelJson: JSON.stringify(e.panel, null, 2),
    })),
  };
}

/** What a field path in a schema issue is called on the form. */
function fieldName(path: readonly PropertyKey[]): string {
  const [section, index, field] = path;
  const n = typeof index === "number" ? ` ${index + 1}` : "";
  if (section === "glossary") return "Glossary";
  if (section === "metricDefinitions")
    return `Metric${n}${field ? ` ${String(field)}` : ""}`;
  if (section === "examples") return `Example${n}${field ? ` ${String(field)}` : ""}`;
  return "Customization";
}

/**
 * The body the form sends, or the first reason it cannot be sent. The same
 * schema the route reads with, so the form refuses what the route would; the
 * route also holds each example's SQL to the guard, which needs the server.
 */
export function promptFromDraft(
  draft: WorkspacePromptDraft,
): { ok: true; prompt: WorkspacePrompt } | { ok: false; message: string } {
  const examples: unknown[] = [];
  for (const [i, e] of draft.examples.entries()) {
    let panel: unknown;
    try {
      panel = JSON.parse(e.panelJson);
    } catch {
      return { ok: false, message: `Example ${i + 1} panel: not valid JSON.` };
    }
    examples.push({ prompt: e.prompt, specVersion: SPEC_VERSION, panel });
  }
  const parsed = WorkspacePrompt.safeParse({
    glossary: draft.glossary,
    metricDefinitions: draft.metricDefinitions,
    examples,
  });
  if (parsed.success) return { ok: true, prompt: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, message: `${fieldName(issue.path)}: ${issue.message}.` };
}
