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

/**
 * What was clicked (#373): the result row a point, slice, cell or row was
 * drawn from, and the name of the series it belongs to when the kind has one.
 * The browser already holds the row; a click only says which.
 */
export interface Datum {
  row: Record<string, unknown>;
  series?: string;
}

/** The most a pick may be, as `VariableText` allows. */
const PICK_MAX = 256;

/** A cell as a pick, or nothing: a value the IR would refuse is never sent. */
function pickText(value: unknown): string | undefined {
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" ||
          typeof value === "boolean" ||
          typeof value === "bigint"
        ? String(value)
        : undefined;
  return text !== undefined && text.length > 0 && text.length <= PICK_MAX
    ? text
    : undefined;
}

/**
 * The picks a link makes: its literals, and, given what was clicked, its
 * `column` and `series` entries read from it. A column the row lacks, or a
 * series the click did not name, leaves that variable unset, so the target
 * falls back to its default; nothing is guessed.
 */
export function linkPicks(link: PanelLink, datum?: Datum): Selection {
  return Object.fromEntries(
    Object.entries(link.set ?? {}).flatMap(([name, v]) => {
      const text =
        "value" in v
          ? v.value
          : !datum
            ? undefined
            : "column" in v
              ? Object.hasOwn(datum.row, v.column)
                ? pickText(datum.row[v.column])
                : undefined
              : pickText(datum.series);
      return text === undefined ? [] : [[name, [text]]];
    }),
  );
}

/**
 * The href of a link to another dashboard: its page, the viewer's window and
 * picks unless the link says not to carry them, and the link's own picks over
 * those: its literals, and what it reads from the clicked datum, if any.
 */
export function linkHref(
  link: PanelLink,
  targetId: string,
  context: LinkContext,
  datum?: Datum,
): string {
  const carry = linkCarries(link);
  const params = new URLSearchParams();
  if (carry.timeRange) {
    params.set("from", context.timeRange.from);
    params.set("to", context.timeRange.to);
  }
  const selection: Selection = {
    ...(carry.variables ? context.selection : {}),
    ...linkPicks(link, datum),
  };
  for (const [key, value] of selectionParams(selection)) params.append(key, value);
  const search = params.toString();
  return `/dashboards/${encodeURIComponent(targetId)}${search ? `?${search}` : ""}`;
}

/**
 * The selection after following a self link: the current picks with the
 * link's over them. The page sets it like a picker change, so the URL and the
 * stream follow and the stream checks every pick again.
 */
export function applySelfLink(
  link: PanelLink,
  selection: Selection,
  datum?: Datum,
): Selection {
  return { ...selection, ...linkPicks(link, datum) };
}

/**
 * One link as the panel offers it. A self link carries the picks it makes,
 * which the page lays over the current selection.
 */
export type MenuLinkItem =
  | { kind: "navigate"; title: string; href: string; newTab: boolean; target: string }
  | { kind: "self"; title: string; picks: Selection }
  | { kind: "unavailable"; title: string };

function linkItem(
  link: PanelLink,
  targets: LinkTargets,
  context: LinkContext,
  datum?: Datum,
): MenuLinkItem {
  if (isSelfLink(link)) {
    return { kind: "self", title: link.title, picks: linkPicks(link, datum) };
  }
  const id = link.dashboard as string;
  const target = Object.hasOwn(targets, id) ? targets[id] : undefined;
  if (!target) return { kind: "unavailable", title: link.title };
  return {
    kind: "navigate",
    title: link.title,
    href: linkHref(link, id, context, datum),
    newTab: link.newTab === true,
    target: target.title,
  };
}

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
    .map((link) => linkItem(link, targets, context));
}

/** The datum links a viewer can follow: self links, and those whose target the server named. */
function usableDatumLinks(panel: Panel, targets: LinkTargets): PanelLink[] {
  return (panel.links ?? []).filter(
    (link) =>
      isDatumLink(link) &&
      (isSelfLink(link) || Object.hasOwn(targets, link.dashboard as string)),
  );
}

/** Whether a click on this panel's data leads anywhere: what turns clicks on. */
export function hasDatumLinks(panel: Panel, targets: LinkTargets): boolean {
  return usableDatumLinks(panel, targets).length > 0;
}

/**
 * What a click on a datum offers: the panel's usable datum links, each with
 * the picks read from what was clicked. A link the viewer cannot follow is
 * left out rather than shown disabled; the panel menu already says so.
 */
export function datumLinkItems(
  panel: Panel,
  targets: LinkTargets,
  context: LinkContext,
  datum: Datum,
): MenuLinkItem[] {
  return usableDatumLinks(panel, targets).map((link) =>
    linkItem(link, targets, context, datum),
  );
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
