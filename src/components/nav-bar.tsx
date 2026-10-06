"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Collapsible } from "@base-ui/react/collapsible";
import { LayoutDashboard, Database, Compass, Menu as MenuIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { NavSlot } from "@/components/nav-slot";
import { ProfileMenu, type ProfileMenuAccount } from "@/components/profile-menu";

const LINKS = [
  { href: "/dashboards", label: "Dashboards", Icon: LayoutDashboard },
  { href: "/explore", label: "Explore", Icon: Compass },
  { href: "/data-sources", label: "Data sources", Icon: Database },
] as const;

/**
 * The top bar. Three links inline on a wide screen; behind a disclosure below
 * `md`, where they would otherwise wrap the header onto two lines and push the
 * dashboard off the top of a phone (#78).
 *
 * A disclosure rather than a menu popup: the links stay real `<Link>`s, so
 * prefetching, middle-click and "open in new tab" keep working, and the panel
 * is ordinary markup rather than a portal over the page. Base UI's
 * Collapsible does the bookkeeping (#235): it measures the panel into
 * `--collapsible-panel-height` so the height can transition, and keeps it
 * mounted until the closing transition ends.
 *
 * The account menu (#210) stays in the bar at every width and carries Sign
 * out, Settings and the theme. `account` is null for a signed-out visitor,
 * who gets no menu: every item in it needs a session.
 */
export function NavBar({ account }: { account: ProfileMenuAccount | null }) {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);

  // A tap on a link navigates without unmounting the bar, so the panel has to
  // be closed by the navigation rather than by the click that caused it.
  // `pathname` is not read in the body — landing somewhere new is the trigger.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate re-run trigger, not a read
  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      render={<header />}
      className="border-b border-border bg-surface"
    >
      {/*
        A fixed height, not padding around the content: a page's controls
        portaled into the NavSlot (the dashboard's time range is 38px) would
        otherwise grow the bar, and it would shift between pages.
      */}
      <div className="flex h-14 items-center justify-between gap-2 px-4 sm:px-6">
        <nav className="flex min-w-0 items-center gap-6" aria-label="Main">
          <Link
            href="/dashboards"
            className="tap-target flex shrink-0 items-center gap-2 font-semibold"
          >
            <LayoutDashboard className="h-5 w-5 text-primary" />
            Holotable
          </Link>
          <div className="hidden items-center gap-6 md:flex">
            {LINKS.map(({ href, label, Icon }) => (
              <Link
                key={href}
                href={href}
                aria-current={pathname === href ? "page" : undefined}
                className="tap-target flex items-center gap-1.5 text-sm text-muted hover:text-foreground aria-[current=page]:text-foreground"
              >
                <Icon className="h-4 w-4" /> {label}
              </Link>
            ))}
          </div>
        </nav>
        <div className="flex shrink-0 items-center gap-2">
          <NavSlot />
          {account && <ProfileMenu account={account} />}
          <Collapsible.Trigger
            render={<Button variant="ghost" size="icon" />}
            className="tap-target md:hidden"
            aria-label={open ? "Close menu" : "Open menu"}
          >
            {/* Both icons stay mounted and crossfade, so the swap is a motion, not a cut. */}
            <span className="relative block h-5 w-5">
              <MenuIcon
                className={cn(
                  "absolute inset-0 h-5 w-5 transition-[opacity,scale] duration-(--duration-fast) ease-standard",
                  open && "scale-75 opacity-0",
                )}
              />
              <X
                className={cn(
                  "absolute inset-0 h-5 w-5 transition-[opacity,scale] duration-(--duration-fast) ease-standard",
                  !open && "scale-75 opacity-0",
                )}
              />
            </span>
          </Collapsible.Trigger>
        </div>
      </div>

      <Collapsible.Panel
        id="main-menu"
        render={<nav aria-label="Main menu" />}
        className="h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-(--duration-base) ease-emphasized data-starting-style:h-0 data-starting-style:opacity-0 data-ending-style:h-0 data-ending-style:opacity-0 md:hidden"
      >
        <div className="flex flex-col border-t border-border px-2 py-1">
          {LINKS.map(({ href, label, Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={pathname === href ? "page" : undefined}
              className="tap-target flex items-center gap-2 px-3 py-3 text-sm text-muted hover:bg-surface-2 hover:text-foreground aria-[current=page]:text-foreground"
            >
              <Icon className="h-4 w-4" /> {label}
            </Link>
          ))}
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
