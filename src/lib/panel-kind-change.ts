import type { Panel, PanelQuery, VizType } from "@/lib/ir";
import { panelKind } from "@/lib/panels/registry";

/**
 * A panel switched to another kind in the editor.
 *
 * Most switches are the same query drawn differently, and keep everything.
 * What a kind asks of the rest of the panel is what moves: a switch to a kind
 * that runs no query (text, #202) drops the query, a switch back needs one
 * and takes `starterQuery()` (the editor's starter for a source), and options
 * that are not the new kind's are dropped rather than left to fail the save.
 * Undo is how the author gets the old ones back. Pure.
 */
export function changePanelKind(
  panel: Panel,
  viz: VizType,
  starterQuery: () => PanelQuery,
): Panel {
  const kind = panelKind(viz);
  const { query: _query, options: _options, ...rest } = panel;
  const next: Panel = { ...rest, viz };

  if (kind.query === "required") next.query = panel.query ?? starterQuery();

  if (kind.options) {
    const kept = panel.options && kind.options.safeParse(panel.options);
    if (kept?.success) next.options = kept.data;
    else if (kind.starterOptions) next.options = kind.starterOptions(panel.title);
  }
  return next;
}
