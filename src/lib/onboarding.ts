import type { CatalogHealth } from "@/lib/catalog/health";

/**
 * The first-run flow: what a new install still has to do before a prompt can
 * become a live dashboard, and who is allowed to do it.
 *
 * Two decisions shape this module.
 *
 * **Progress is derived, never stored.** A step is done because the workspace
 * says so — a source exists, its catalog has been refreshed, a dashboard has
 * been saved — not because someone pressed Next. That makes the flow resumable
 * for free (leave, come back, the state is still right), impossible to desync
 * from reality, and correct for a second user arriving at an install a
 * colleague already set up. The only thing that *is* stored is the dismissal,
 * and a dismissal hides the flow rather than completing it.
 *
 * **Roles decide the action, not the step.** A viewer looking at an empty
 * install is not told to go and create a data source; they are told what the
 * install is waiting for and who can do it. The steps are the same three for
 * everyone, because the explanation is useful to everyone — only the button
 * changes.
 *
 * Pure and synchronous. It reads facts a page has already fetched and
 * authorized; it never queries and never decides access. `can()` remains the
 * only authorization.
 */

/**
 * The walkthrough that says the same three steps in prose, for a reader who
 * skipped or dismissed the flow. The hosted docs site rather than a relative
 * path: the docs are a separate deployment, and the README already links to it
 * this way.
 */
export const FIRST_DASHBOARD_DOCS_URL =
  "https://holotable-docs.beskar.workers.dev/getting-started/your-first-dashboard/";

export type OnboardingStepId = "connect" | "verify" | "generate";

/** `current` is the first step that is not done; everything after it is `todo`. */
export type OnboardingStepStatus = "done" | "current" | "todo";

/** What the flow needs of a source: only whether its catalog can be believed. */
export interface OnboardingSubject {
  catalog: CatalogHealth;
}

export interface OnboardingFacts {
  /** Every source visible in the caller's workspaces, reduced to its catalog. */
  sources: OnboardingSubject[];
  /** Dashboards visible in the caller's workspaces. */
  dashboardCount: number;
  /** Whether the caller holds `source:manage` in any accessible workspace. */
  canManageSources: boolean;
  /** Whether the caller holds `dashboard:create` in any accessible workspace. */
  canCreateDashboards: boolean;
}

export interface OnboardingAction {
  label: string;
  /** An in-app route. Nothing here links off-site except the docs constants. */
  href: string;
}

export interface OnboardingStep {
  id: OnboardingStepId;
  title: string;
  /** One sentence: what the step does, and the failure it prevents. */
  detail: string;
  status: OnboardingStepStatus;
  /** Where the step is performed, or null when the caller lacks the role. */
  action: OnboardingAction | null;
  /** Who the caller is waiting on. Set exactly when `action` is null. */
  waitingOn: string | null;
}

export interface OnboardingState {
  /** Always all three, in order, whatever the caller may do. */
  steps: OnboardingStep[];
  doneCount: number;
  /** The first step not yet done; null once all three are. */
  currentStepId: OnboardingStepId | null;
  complete: boolean;
  /**
   * Whether any remaining step is one this caller can actually perform. False
   * for a viewer on an empty install, which is the signal to show a short
   * "waiting on someone else" note instead of three buttons they cannot press.
   */
  actionable: boolean;
}

/** Role sentences, written once so every surface waits on the same person. */
const NEEDS_SOURCE_ADMIN =
  "Connecting a data source needs the source-admin role in a workspace. Ask an administrator to add one.";
const NEEDS_EDITOR =
  "Creating a dashboard needs the editor role in a workspace. Ask an editor to build the first one.";

/**
 * A source counts as verified when its catalog is not {@link CatalogHealth.blocked}
 * — the same judgement `/api/generate` refuses on. Reusing it is the point: the
 * step cannot call itself done while generation would still be refused.
 */
function verified(source: OnboardingSubject): boolean {
  return !source.catalog.blocked;
}

/** The three steps and their state, given what the caller can see and do. */
export function onboardingState(facts: OnboardingFacts): OnboardingState {
  const done: Record<OnboardingStepId, boolean> = {
    connect: facts.sources.length > 0,
    verify: facts.sources.some(verified),
    generate: facts.dashboardCount > 0,
  };

  const currentStepId =
    (["connect", "verify", "generate"] as const).find((id) => !done[id]) ?? null;

  const steps: OnboardingStep[] = [
    {
      id: "connect",
      title: "Connect a data source",
      detail:
        "Register the database Holotable reads. Its credentials live in the server environment under a secret reference, so they never reach a dashboard or the browser.",
      status: statusOf("connect", done, currentStepId),
      action: facts.canManageSources
        ? { label: "Add a data source", href: "/data-sources?new=1" }
        : null,
      waitingOn: facts.canManageSources ? null : NEEDS_SOURCE_ADMIN,
    },
    {
      id: "verify",
      title: "Test and refresh the catalog",
      detail:
        "Test proves the credentials resolve and the server can connect. Refresh reads the tables and columns the model is allowed to see — until it has run, generation is refused rather than guessed at.",
      status: statusOf("verify", done, currentStepId),
      action: facts.canManageSources
        ? { label: "Test and refresh", href: "/data-sources" }
        : null,
      waitingOn: facts.canManageSources ? null : NEEDS_SOURCE_ADMIN,
    },
    {
      id: "generate",
      title: "Generate your first dashboard",
      detail:
        "Describe what you want to watch in plain English. The model writes the spec; the server runs the guarded SQL and streams the results back.",
      status: statusOf("generate", done, currentStepId),
      action: facts.canCreateDashboards
        ? { label: "New dashboard", href: "/dashboards/new" }
        : null,
      waitingOn: facts.canCreateDashboards ? null : NEEDS_EDITOR,
    },
  ];

  return {
    steps,
    doneCount: steps.filter((step) => step.status === "done").length,
    currentStepId,
    complete: currentStepId === null,
    actionable: steps.some((step) => step.status !== "done" && step.action !== null),
  };
}

function statusOf(
  id: OnboardingStepId,
  done: Record<OnboardingStepId, boolean>,
  currentStepId: OnboardingStepId | null,
): OnboardingStepStatus {
  if (done[id]) return "done";
  return id === currentStepId ? "current" : "todo";
}

/**
 * The empty state for a surface that needs a data source and has none —
 * Explore and the new-dashboard page.
 *
 * Here rather than in each component so that the wording, and in particular
 * who the reader is told to ask, is decided in the one place that already
 * knows the rule. An editor without `source:manage` is a real configuration:
 * they can build dashboards and cannot add the source to build them from, and
 * "create one under Data sources" is a dead end for them.
 */
export function noSourceGuidance(canManageSources: boolean): {
  title: string;
  body: string;
  action: OnboardingAction | null;
} {
  return {
    title: "No data sources yet",
    body: canManageSources
      ? "Holotable queries a registered source, never the model. Connect one, then Test it and Refresh its catalog — that is what the generator is allowed to read."
      : "Holotable queries a registered source, never the model. None are available in your workspaces yet, and connecting one needs the source-admin role.",
    action: canManageSources
      ? { label: "Add a data source", href: "/data-sources?new=1" }
      : null,
  };
}
