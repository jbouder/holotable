"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Building2,
  HardDrive,
  Keyboard,
  type LucideIcon,
  Palette,
  SlidersHorizontal,
  UserRound,
} from "lucide-react";
import type { SettingsSectionId } from "@/lib/settings";

const ICONS: Record<SettingsSectionId, LucideIcon> = {
  account: UserRound,
  appearance: Palette,
  preferences: SlidersHorizontal,
  "local-data": HardDrive,
  shortcuts: Keyboard,
  workspaces: Building2,
};

/**
 * The section list. A column beside the content from `md`; above it below
 * `md`, wrapping onto a second row rather than scrolling sideways, so every
 * section stays one tap away on a phone.
 */
export function SettingsNav({
  sections,
}: {
  sections: { id: SettingsSectionId; label: string; href: string }[];
}) {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings" className="md:w-52 md:shrink-0">
      <ul className="flex flex-wrap gap-1 md:flex-col">
        {sections.map(({ id, label, href }) => {
          const Icon = ICONS[id];
          const current = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={id}>
              <Link
                href={href}
                aria-current={current ? "page" : undefined}
                className="tap-target flex items-center gap-2 border border-transparent px-3 py-2 text-sm text-muted hover:bg-surface-2 hover:text-foreground aria-[current=page]:border-border aria-[current=page]:bg-surface aria-[current=page]:text-foreground"
              >
                <Icon className="h-4 w-4" aria-hidden />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
