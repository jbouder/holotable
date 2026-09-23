"use client";

import { ChevronDown, Keyboard, LogOut, Settings, UserRound } from "lucide-react";
import {
  Menu,
  MenuItem,
  MenuLink,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "@/components/ui/menu";
import { THEME_OPTIONS, useThemePreference } from "@/components/theme-toggle";
import { initials } from "@/lib/initials";
import type { Theme } from "@/lib/theme";

/** What the header knows about the signed-in person. Display only. */
export interface ProfileMenuAccount {
  displayName: string | null;
  email: string | null;
}

/**
 * The account menu at the right of the header (#210): who is signed in, the
 * way into Settings, the theme, and Sign out. It replaces the bar's bare Sign
 * out button and theme toggle, and it is the same control at every width, so
 * there is one place for a person's own things. The trigger shows who is
 * signed in without opening it: initials always, the name beside them from
 * `sm` up.
 */
export function ProfileMenu({ account }: { account: ProfileMenuAccount }) {
  const [theme, setTheme] = useThemePreference();
  const letters = initials(account);
  const name = account.displayName ?? account.email;

  // A full navigation rather than a client-side push: signing out should
  // leave nothing of the signed-in page behind in the router cache.
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.assign("/dashboards");
  }

  return (
    <Menu
      label={name ? `${name}, account menu` : "Account menu"}
      className="group h-8 w-auto gap-1.5 px-1 text-foreground"
      panelClassName="w-64"
      trigger={
        <>
          <span
            aria-hidden
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-surface-2 text-xs font-semibold"
          >
            {letters ?? <UserRound className="h-4 w-4" />}
          </span>
          {/* The name is the point of the pill, but below `sm` it would push
              the bar onto two lines (#78); there the initials carry it. */}
          {name && (
            <span aria-hidden className="hidden max-w-40 truncate text-sm sm:inline">
              {name}
            </span>
          )}
          <ChevronDown
            aria-hidden
            className="h-4 w-4 shrink-0 text-muted motion-safe:transition-transform group-data-[popup-open]:rotate-180"
          />
        </>
      }
    >
      <div className="px-2 pt-1.5 pb-2">
        <p className="truncate text-sm font-semibold">{name ?? "Signed in"}</p>
        {account.displayName && account.email && (
          <p className="truncate text-xs text-muted">{account.email}</p>
        )}
      </div>
      <MenuSeparator />
      <MenuLink href="/settings">
        <Settings className="h-4 w-4" aria-hidden /> Settings
      </MenuLink>
      <MenuLink href="/settings/shortcuts">
        <Keyboard className="h-4 w-4" aria-hidden /> Keyboard shortcuts
      </MenuLink>
      <MenuSeparator />
      <MenuRadioGroup<Theme> label="Theme" value={theme} onValueChange={setTheme}>
        {THEME_OPTIONS.map(({ value, label, Icon }) => (
          <MenuRadioItem key={value} value={value}>
            <Icon className="h-4 w-4" aria-hidden /> {label}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      <MenuSeparator />
      <MenuItem onClick={() => void logout()}>
        <LogOut className="h-4 w-4" aria-hidden /> Sign out
      </MenuItem>
    </Menu>
  );
}
