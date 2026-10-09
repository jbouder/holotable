import {
  type Dashboard,
  isDatumLink,
  isSelfLink,
  linkCarries,
  type Panel,
  type PanelLink,
  type TimeRange,
} from "@/lib/ir";
import { type Selection, selectionParams } from "@/lib/variable-selection";

/**
 * Drilldown (#370): turning a panel's links into what the viewer can follow.
 *
 * Browser-safe and free of React, so the dashboard page, the panel menu and
 * the tests share one answer. The server decides which targets exist and may
 * be opened ({@link LinkTargets}); this module only builds hrefs to those, and
 * an id the server did not name never becomes one.
 *
 * An href carries time expressions and variable picks, nothing else. The
 * target page resolves the window on the server and checks every pick against
 * its own variable, exactly as it does for a URL typed by hand.
 */

/** A target the server says exists, is in this workspace, and the viewer may open. */
export interface LinkTarget {
  title: string;
}

/** The targets the viewer may follow, by dashboard id. An absent id is not one. */
export type LinkTargets = Record<string, LinkTarget>;

/** What the viewer is looking at when a link is followed. */
export interface LinkContext {
  /** The window as IR expressions (`now-1h`), not resolved instants. */
  timeRange: TimeRange;
  /** The current picks. */
  selection: Selection;
}

/** The distinct dashboard ids a spec's links name, in panel order. */
export function linkTargetIds(spec: Pick<Dashboard, "panels">): string[] {
  const ids = spec.panels.flatMap((p) =>
    (p.links ?? []).flatMap((l) => (l.dashboard === undefined ? [] : [l.dashboard])),
  );
  return [...new Set(ids)];
}

/** The picks a link sets from literals alone, as a selection. */
function literalPicks(link: PanelLink): Selection {
  return Object.fromEntries(
    Object.entries(link.set ?? {}).flatMap(([name, v]) =>
      "value" in v ? [[name, [v.value]]] : [],
    ),
  );
}

/**
 * The href of a link to another dashboard: its page, the viewer's window and
 * picks unless the link says not to carry them, and the link's literal picks
 * over those. Datum picks need a click on a point and are not this function's
 * (Phase 3, #373).
 */
export function linkHref(
  link: PanelLink,
  targetId: string,
  context: LinkContext,
): string {
  const carry = linkCarries(link);
  const params = new URLSearchParams();
  if (carry.timeRange) {
    params.set("from", context.timeRange.from);
    params.set("to", context.timeRange.to);
  }
  const selection: Selection = {
    ...(carry.variables ? context.selection : {}),
    ...literalPicks(link),
  };
  for (const [key, value] of selectionParams(selection)) params.append(key, value);
  const search = params.toString();
  return `/dashboards/${encodeURIComponent(targetId)}${search ? `?${search}` : ""}`;
}

/**
 * The selection after following a self link: the current picks with the
 * link's literal ones over them. The page sets it like a picker change, so the
 * URL and the stream follow and the stream checks every pick again.
 */
export function applySelfLink(link: PanelLink, selection: Selection): Selection {
  return { ...selection, ...literalPicks(link) };
}

/** One link as the panel menu offers it. */
export type MenuLinkItem =
  | { kind: "navigate"; title: string; href: string; newTab: boolean; target: string }
  | { kind: "self"; title: string; link: PanelLink }
  | { kind: "unavailable"; title: string };

/**
 * A panel's links as its menu shows them: the ones followed from the menu
 * (not datum links, which need a click on a point), each a working href when
 * the server named its target, a self link, or disabled. Order is the spec's.
 */
export function menuLinks(
  panel: Panel,
  targets: LinkTargets,
  context: LinkContext,
): MenuLinkItem[] {
  return (panel.links ?? [])
    .filter((link) => !isDatumLink(link))
    .map((link): MenuLinkItem => {
      if (isSelfLink(link)) return { kind: "self", title: link.title, link };
      const id = link.dashboard as string;
      const target = Object.hasOwn(targets, id) ? targets[id] : undefined;
      if (!target) return { kind: "unavailable", title: link.title };
      return {
        kind: "navigate",
        title: link.title,
        href: linkHref(link, id, context),
        newTab: link.newTab === true,
        target: target.title,
      };
    });
}

/** Whether a panel leads anywhere the viewer can go: what the header's glyph says. */
export function hasUsableLinks(items: MenuLinkItem[]): boolean {
  return items.some((i) => i.kind !== "unavailable");
}

/**
 * A spec with every link to another dashboard removed, keeping self links: a
 * template is reused across workspaces and instances, where a dashboard id
 * would point at nothing, or at the wrong thing.
 */
export function withoutDashboardLinks<T extends Pick<Panel, "links">>(panel: T): T {
  if (!panel.links) return panel;
  const links = panel.links.filter(isSelfLink);
  const { links: _, ...rest } = panel;
  return (links.length > 0 ? { ...rest, links } : rest) as T;
}
