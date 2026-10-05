import { z } from "zod";
import { definePanelKind } from "@/lib/panels/types";

/** Long enough for a runbook section; short enough to stay a panel. */
export const TEXT_CONTENT_MAX = 10_000;

export const TextOptions = z
  .object({
    /**
     * Markdown, rendered as a sanitized subset: headings, emphasis, lists,
     * code, tables and http(s)/mailto links. Raw HTML is shown as text.
     */
    content: z.string().min(1).max(TEXT_CONTENT_MAX),
  })
  .strict();
export type TextOptions = z.infer<typeof TextOptions>;

/** Words for the reader, and no query (#202). */
export const text = definePanelKind({
  kind: "text",
  summary:
    "Markdown in `options.content`: a heading, what the dashboard is for, a runbook link. Runs no query and carries no `query`.",
  promptHint:
    "prose a reader needs: a heading, what the dashboard is for, a runbook link. Put Markdown in options.content and OMIT 'query' entirely. Describe intent only: never a number, a result or a trend.",
  canvas: false,
  timeBrush: false,
  skeleton: "text",
  query: "none",
  options: TextOptions,
  starterOptions: (title) => ({ content: `## ${title}\n\nWhat this dashboard is for.` }),
});
