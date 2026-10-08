import { authorizedWorkspaces } from "@/lib/auth/authorize";
import type { Identity } from "@/lib/auth/claims";
import { config } from "@/lib/config";

/**
 * The sections of `/settings` (#209), as data.
 *
 * The layout draws its nav from this list and each section is an ordinary
 * route at `href`, so adding one is an entry here and a page beside the
 * others, never an edit to the layout. A section with `visible` is listed
 * only for identities it returns true for, and its page answers 404 for the
 * rest ({@link sectionVisible}), so hiding a link is never the only check.
 */

export const SETTINGS_SECTION_IDS = [
  "account",
  "appearance",
  "preferences",
  "local-data",
  "shortcuts",
  "workspaces",
  "ai-context",
  "model",
  "personal-model",
  "tokens",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  /** One line under the section's heading. */
  description: string;
  href: string;
  visible?: (identity: Identity) => boolean;
}

/** May generate somewhere, which an editor and a platform admin always may. */
function generatesInAWorkspace(identity: Identity): boolean {
  return (
    identity.platformAdmin ||
    authorizedWorkspaces(identity, "dashboard:generate").length > 0
  );
}

/** Holds `source:manage` somewhere, which a platform admin always does. */
function managesAWorkspace(identity: Identity): boolean {
  return (
    identity.platformAdmin || authorizedWorkspaces(identity, "source:manage").length > 0
  );
}

/**
 * Model configuration in the app (#331) is off in demo mode, where the
 * server's model is the only one, and for a service-account token, which is
 * not a person.
 */
function configuresModels(identity: Identity): boolean {
  return config.authMode !== "demo" && !identity.serviceAccount;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: "account",
    label: "Account",
    description: "Who you are signed in as, and what you can reach.",
    href: "/settings/account",
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "How Holotable looks on this device.",
    href: "/settings/appearance",
  },
  {
    id: "preferences",
    label: "Preferences",
    description:
      "Where you start, how times are shown, what history is kept, and how Explore opens.",
    href: "/settings/preferences",
  },
  {
    id: "local-data",
    label: "Local data",
    description: "What this browser remembers, and how to clear it.",
    href: "/settings/local-data",
  },
  {
    id: "shortcuts",
    label: "Keyboard shortcuts",
    description: "Every key binding, by where it works.",
    href: "/settings/shortcuts",
  },
  {
    id: "workspaces",
    label: "Workspaces",
    description: "AI usage and limits for the workspaces you administer.",
    href: "/settings/workspaces",
    visible: managesAWorkspace,
  },
  {
    id: "ai-context",
    label: "AI context",
    description:
      "What the model is told about each workspace: its vocabulary, metrics and example panels.",
    href: "/settings/ai-context",
    visible: generatesInAWorkspace,
  },
  {
    id: "model",
    label: "Workspace model",
    description:
      "Which model each workspace you administer generates with, and whether people may bring their own.",
    href: "/settings/model",
    visible: (identity) => configuresModels(identity) && managesAWorkspace(identity),
  },
  {
    id: "personal-model",
    label: "Personal model",
    description:
      "Your own model and key, used for your generations in workspaces that allow it.",
    href: "/settings/personal-model",
    visible: (identity) => configuresModels(identity) && generatesInAWorkspace(identity),
  },
  {
    id: "tokens",
    label: "API tokens",
    description: "Service-account tokens for pipelines and scripts that call the API.",
    href: "/settings/tokens",
    visible: managesAWorkspace,
  },
];

/** Where `/settings` itself lands. */
export const DEFAULT_SETTINGS_HREF = SETTINGS_SECTIONS[0].href;

export function settingsSection(id: SettingsSectionId): SettingsSection {
  const section = SETTINGS_SECTIONS.find((s) => s.id === id);
  if (!section) throw new Error(`unknown settings section: ${id}`);
  return section;
}

export function sectionVisible(section: SettingsSection, identity: Identity): boolean {
  return section.visible ? section.visible(identity) : true;
}

/** The sections this identity is shown, in order. */
export function visibleSections(identity: Identity): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((s) => sectionVisible(s, identity));
}
