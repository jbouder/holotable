"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  Database,
  Compass,
  LogOut,
  Menu as MenuIcon,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";

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
 * is ordinary markup rather than a portal over the page.
 */
export function NavBar() {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);

  // A tap on a link navigates without unmounting the bar, so the panel has to
  // be closed by the navigation rather than by the click that caused it.
  // `pathname` is not read in the body — landing somewhere new is the trigger.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate re-run trigger, not a read
  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/dashboards");
    router.refresh();
  }

  return (
    <header className="border-b border-border bg-surface">
      <div className="flex items-center justify-between gap-2 px-4 py-3 sm:px-6">
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
          <ThemeToggle />
          <Button
            variant="ghost"
            size="sm"
            onClick={logout}
            className="hidden md:inline-flex"
          >
            <LogOut className="h-4 w-4" /> Sign out
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="tap-target md:hidden"
            aria-expanded={open}
            aria-controls="main-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((was) => !was)}
          >
            {open ? <X className="h-5 w-5" /> : <MenuIcon className="h-5 w-5" />}
          </Button>
        </div>
      </div>

      {open && (
        <nav
          id="main-menu"
          aria-label="Main menu"
          className="flex flex-col border-t border-border px-2 py-1 md:hidden"
        >
          {LINKS.map(({ href, label, Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={pathname === href ? "page" : undefined}
              className="tap-target flex items-center gap-2 rounded-lg px-3 py-3 text-sm text-muted hover:bg-surface-2 hover:text-foreground aria-[current=page]:text-foreground"
            >
              <Icon className="h-4 w-4" /> {label}
            </Link>
          ))}
          <Button
            variant="ghost"
            onClick={logout}
            className="tap-target justify-start px-3 py-3 text-sm font-normal text-muted"
          >
            <LogOut className="h-4 w-4" /> Sign out
          </Button>
        </nav>
      )}
    </header>
  );
}
