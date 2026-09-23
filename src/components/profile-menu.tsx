"use client";

import { Keyboard, LogOut, Settings, UserRound } from "lucide-react";
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
 * there is one place for a person's own things.
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
      label="Account menu"
      className="h-8 w-8 rounded-full border border-border bg-surface-2 text-xs font-semibold text-foreground"
      panelClassName="w-64"
      trigger={
        letters ? (
          <span aria-hidden>{letters}</span>
        ) : (
          <UserRound className="h-4 w-4" aria-hidden />
        )
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
