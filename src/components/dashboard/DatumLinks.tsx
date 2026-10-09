"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Popover as BasePopover } from "@base-ui/react/popover";
import { ArrowUpRight } from "lucide-react";
import type { ChartContext } from "@/components/charts/options";
import { Menu, MenuItem } from "@/components/ui/menu";
import type { Datum, MenuLinkItem } from "@/lib/drilldown";
import type { Selection } from "@/lib/variable-selection";
import { cn } from "@/lib/utils";

/**
 * Following a link from what was clicked (#373): a point, slice or cell on a
 * chart, a row of a table, a stat's number, or a row of a chart's hidden table.
 *
 * A panel with datum links provides this context; the bodies that can be
 * clicked read it, so none of the renderers takes new props, and a panel
 * without links (or a share link) provides nothing and renders as before.
 */
export interface DatumLinks {
  /** The links a click on this datum offers, with the picks read from it. */
  itemsFor: (datum: Datum) => MenuLinkItem[];
  /** Follow one: navigate, or set the dashboard's picks in place. */
  follow: (item: MenuLinkItem) => void;
  /** The window the rows were drawn over, which a timeline's spans depend on. */
  window?: ChartContext["window"];
}

const DatumLinksContext = React.createContext<DatumLinks | null>(null);

/** The panel's datum links, or null where clicking leads nowhere. */
export function useDatumLinks(): DatumLinks | null {
  return React.useContext(DatumLinksContext);
}

export function DatumLinksProvider({
  itemsFor,
  onPick,
  window,
  children,
}: {
  itemsFor: (datum: Datum) => MenuLinkItem[];
  onPick: (picks: Selection) => void;
  window?: ChartContext["window"];
  children: React.ReactNode;
}) {
  const router = useRouter();
  const follow = React.useCallback(
    (item: MenuLinkItem) => {
      if (item.kind === "self") onPick(item.picks);
      if (item.kind !== "navigate") return;
      if (item.newTab) globalThis.open(item.href, "_blank", "noopener,noreferrer");
      else router.push(item.href);
    },
    [router, onPick],
  );
  const value = React.useMemo(
    () => ({ itemsFor, follow, window }),
    [itemsFor, follow, window],
  );
  return (
    <DatumLinksContext.Provider value={value}>{children}</DatumLinksContext.Provider>
  );
}

/** Where a click landed and what it offers: one link is followed, several are listed. */
export interface DatumChoice {
  x: number;
  y: number;
  items: MenuLinkItem[];
}

/**
 * Offer what a click on a datum leads to: follow the one link there is, or
 * hand back the choice for {@link DatumLinksPopover} to list. A click on
 * nothing that leads anywhere does nothing.
 */
export function useDatumClick(
  links: DatumLinks | null,
): [DatumChoice | null, (datum: Datum | null, x: number, y: number) => void, () => void] {
  const [choice, setChoice] = React.useState<DatumChoice | null>(null);
  const onDatum = React.useCallback(
    (datum: Datum | null, x: number, y: number) => {
      if (!links || !datum) return;
      const items = links.itemsFor(datum).filter((i) => i.kind !== "unavailable");
      if (items.length === 0) return;
      if (items.length === 1) {
        links.follow(items[0] as MenuLinkItem);
        return;
      }
      setChoice({ x, y, items });
    },
    [links],
  );
  const close = React.useCallback(() => setChoice(null), []);
  return [choice, onDatum, close];
}

const ITEM =
  "tap-target flex w-full cursor-pointer select-none items-center gap-2 px-2 py-1.5 text-left text-sm text-foreground outline-none hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-2 focus-visible:outline-primary";

/** One link as a control: a real link to another dashboard, a button for a self link. */
function LinkControl({
  item,
  follow,
  onDone,
  className,
  label,
  children,
}: {
  item: MenuLinkItem;
  follow: (item: MenuLinkItem) => void;
  onDone?: () => void;
  className?: string;
  label?: string;
  children: React.ReactNode;
}) {
  if (item.kind === "navigate") {
    return (
      <a
        href={item.href}
        target={item.newTab ? "_blank" : undefined}
        rel={item.newTab ? "noopener noreferrer" : undefined}
        aria-label={label}
        title={`Open ${item.target}`}
        onClick={onDone}
        className={className}
      >
        {children}
      </a>
    );
  }
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        follow(item);
        onDone?.();
      }}
      className={className}
    >
      {children}
    </button>
  );
}

/**
 * The links a click offers, listed at the point it landed. A Base UI popover
 * anchored to that point, so Escape and a click outside close it and its
 * enter and exit are the shared popup motion (`data-starting-style`).
 */
export function DatumLinksPopover({
  choice,
  onClose,
  label,
}: {
  choice: DatumChoice | null;
  onClose: () => void;
  /** Names the list for a screen reader: what was clicked on. */
  label: string;
}) {
  const links = useDatumLinks();
  // Kept while the popup animates out, so its content does not vanish first.
  const [shown, setShown] = React.useState(choice);
  if (choice && choice !== shown) setShown(choice);
  const anchor = React.useMemo(() => {
    const x = shown?.x ?? 0;
    const y = shown?.y ?? 0;
    return {
      getBoundingClientRect: () => DOMRect.fromRect({ x, y, width: 0, height: 0 }),
    };
  }, [shown]);
  if (!links || !shown) return null;
  return (
    <BasePopover.Root
      open={choice !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <BasePopover.Portal>
        <BasePopover.Positioner
          anchor={anchor}
          side="bottom"
          align="start"
          sideOffset={4}
          className="z-50"
        >
          <BasePopover.Popup
            aria-label={label}
            className={cn(
              "min-w-44 border border-border bg-surface p-1 shadow-xl focus:outline-none",
              "transition-[opacity,translate] duration-(--duration-fast) ease-standard data-starting-style:opacity-0 data-ending-style:opacity-0 data-[side=bottom]:data-starting-style:-translate-y-1 data-[side=bottom]:data-ending-style:-translate-y-1 data-[side=top]:data-starting-style:translate-y-1 data-[side=top]:data-ending-style:translate-y-1",
            )}
          >
            <ul>
              {shown.items.map((item) => (
                <li key={item.title}>
                  <LinkControl
                    item={item}
                    follow={links.follow}
                    onDone={onClose}
                    className={ITEM}
                  >
                    <ArrowUpRight className="h-4 w-4" aria-hidden /> {item.title}
                  </LinkControl>
                </li>
              ))}
            </ul>
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}

/**
 * A row's links, in a trailing cell: the one link as an icon control, or a
 * menu of several. The keyboard's way to everything a click can follow.
 */
export function DatumLinksControl({ datum, label }: { datum: Datum; label: string }) {
  const links = useDatumLinks();
  if (!links) return null;
  const items = links.itemsFor(datum).filter((i) => i.kind !== "unavailable");
  if (items.length === 0) return null;
  if (items.length === 1) {
    const item = items[0] as MenuLinkItem;
    return (
      <LinkControl
        item={item}
        follow={links.follow}
        label={`${label}: ${item.title}`}
        className="tap-target inline-flex h-7 w-7 items-center justify-center text-muted transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
      >
        <ArrowUpRight className="h-4 w-4" aria-hidden />
      </LinkControl>
    );
  }
  return (
    <Menu label={`Links for ${label}`} trigger={<ArrowUpRight className="h-4 w-4" />}>
      <LinkMenuItems items={items} follow={links.follow} />
    </Menu>
  );
}

/**
 * A panel whose whole body is the datum (a stat): one control over the body,
 * named "<panel>: <link>", or a menu when there are several.
 */
export function DatumLinksBody({
  datum,
  label,
  children,
}: {
  datum: Datum | null;
  label: string;
  children: React.ReactNode;
}) {
  const links = useDatumLinks();
  const items =
    links && datum ? links.itemsFor(datum).filter((i) => i.kind !== "unavailable") : [];
  if (!links || items.length === 0) return <>{children}</>;
  const body =
    "block h-full w-full cursor-pointer focus-visible:outline-2 focus-visible:outline-primary";
  if (items.length === 1) {
    const item = items[0] as MenuLinkItem;
    return (
      <LinkControl
        item={item}
        follow={links.follow}
        label={`${label}: ${item.title}`}
        className={body}
      >
        {children}
      </LinkControl>
    );
  }
  return (
    <Menu
      label={`Links for ${label}`}
      trigger={children}
      className="block h-full w-full hover:bg-transparent data-[popup-open]:bg-transparent text-inherit hover:text-inherit"
    >
      <LinkMenuItems items={items} follow={links.follow} />
    </Menu>
  );
}

/** Links as menu items: a real link to another dashboard, an action for a self link. */
export function LinkMenuItems({
  items,
  follow,
}: {
  items: MenuLinkItem[];
  follow: (item: MenuLinkItem) => void;
}) {
  return items.map((item) =>
    item.kind === "navigate" ? (
      <MenuItem
        key={item.title}
        href={item.href}
        target={item.newTab ? "_blank" : undefined}
        title={`Open ${item.target}`}
      >
        <ArrowUpRight className="h-4 w-4" /> {item.title}
      </MenuItem>
    ) : (
      <MenuItem key={item.title} onClick={() => follow(item)}>
        <ArrowUpRight className="h-4 w-4" /> {item.title}
      </MenuItem>
    ),
  );
}
