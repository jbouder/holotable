import type { Panel } from "@/lib/ir";
import { panelKind } from "@/lib/panels/registry";

/**
 * Editing a panel's options one field at a time (#115), as the editor's
 * controls do. A change is applied to the options the panel has and checked
 * against its kind's schema before it reaches the spec, so the spec never
 * holds options its kind would refuse; the control keeps what was typed and
 * shows why it was not taken.
 */

export type OptionsEdit = { ok: true; panel: Panel } | { ok: false; error: string };

/**
 * The panel with `patch` merged into its options. A field set to undefined is
 * removed, and options left empty are dropped, so a panel whose every control
 * is back at its default is the panel it was before options existed.
 */
export function withOptions(panel: Panel, patch: Record<string, unknown>): OptionsEdit {
  const schema = panelKind(panel.viz).options;
  if (!schema) return { ok: false, error: `a ${panel.viz} panel takes no options` };
  const next: Record<string, unknown> = { ...panel.options, ...patch };
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) delete next[key];
  }
  const parsed = schema.safeParse(next);
  if (!parsed.success) return { ok: false, error: describeIssue(parsed.error.issues[0]) };
  const { options: _, ...rest } = panel;
  return {
    ok: true,
    panel: Object.keys(next).length > 0 ? { ...rest, options: next } : rest,
  };
}

/** One schema issue as a line under the control it is about. */
export function describeIssue(
  issue: { path: PropertyKey[]; message: string } | undefined,
): string {
  if (!issue) return "Not valid for this kind.";
  const at = issue.path.length > 0 ? `${issue.path.map(String).join(".")}: ` : "";
  return `${at}${issue.message}`;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** A number box: empty is "not set", anything else must be a finite number. */
export function parseOptionalNumber(text: string): Parsed<number | undefined> {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: undefined };
  const n = Number(trimmed);
  return Number.isFinite(n)
    ? { ok: true, value: n }
    : { ok: false, error: "Not a number." };
}

/** A text box: empty is "not set". */
export function parseOptionalText(text: string): Parsed<string | undefined> {
  const trimmed = text.trim();
  return { ok: true, value: trimmed === "" ? undefined : trimmed };
}

/**
 * The cadences the editor offers a panel of its own (#114). Any other value a
 * spec holds is shown as itself; the server's floor applies to all of them.
 */
export const REFRESH_PRESETS_MS = [
  5_000, 10_000, 15_000, 30_000, 60_000, 300_000, 900_000, 3_600_000,
] as const;
