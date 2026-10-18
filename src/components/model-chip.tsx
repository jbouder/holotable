"use client";

import * as React from "react";
import { Cpu } from "lucide-react";
import { COMPOSER_CHIP_CLASS } from "@/components/composer-chip";
import {
  Menu,
  MenuCaption,
  MenuLink,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "@/components/ui/menu";
import type { ModelListing, ModelsResponse } from "@/lib/ai/model-config";
import { cn } from "@/lib/utils";

const SCOPES: Array<{ scope: ModelListing["scope"]; label: string }> = [
  { scope: "environment", label: "Server" },
  { scope: "workspace", label: "Workspace" },
  { scope: "personal", label: "Yours" },
];

/**
 * The models a caller may pick in a workspace (#442), from `GET /api/models`.
 * Null while loading, and when the listing cannot be read (the chip then
 * draws nothing, and requests carry no pick).
 */
export function useModelListing(workspaceId: string | null): ModelsResponse | null {
  const [listing, setListing] = React.useState<ModelsResponse | null>(null);
  React.useEffect(() => {
    setListing(null);
    if (!workspaceId) return;
    let active = true;
    void (async () => {
      try {
        const res = await fetch(
          `/api/models?workspace=${encodeURIComponent(workspaceId)}`,
        );
        if (active && res.ok) setListing((await res.json()) as ModelsResponse);
      } catch {
        // No listing, no chip: the request falls back to the default.
      }
    })();
    return () => {
      active = false;
    };
  }, [workspaceId]);
  return listing;
}

/**
 * Which model a surface's requests name (#442). Until the person picks,
 * it is `initial` (a conversation's stored model) or nothing, and a request
 * without one gets the default the server resolves: their last pick here,
 * else the workspace's. A pick holds for its workspace; another workspace
 * starts over.
 */
export function useModelChoice(
  workspaceId: string | null,
  initial: string | null = null,
) {
  const [picked, setPicked] = React.useState<{
    workspaceId: string | null;
    id: string;
  } | null>(null);
  const listing = useModelListing(workspaceId);
  const id = picked && picked.workspaceId === workspaceId ? picked.id : initial;
  // Shown and used: the pick while it is still offered, else the default.
  const current =
    listing?.models.find((m) => m.id === id) ??
    listing?.models.find((m) => m.id === listing.defaultModel) ??
    null;
  return {
    listing,
    current,
    /** What a request body carries: the pick, or nothing for the default. */
    modelId: id && current?.id === id ? id : undefined,
    pick: (next: string) => setPicked({ workspaceId, id: next }),
  };
}

export type ModelChoice = ReturnType<typeof useModelChoice>;

/**
 * The model chip beside the source chip on every generation surface (#442).
 * Its menu lists the caller's models, Server, then the workspace's, then
 * their own; one that cannot be called is disabled with its reason. A link
 * goes to the Models page.
 */
export function ModelChip({
  choice,
  disabled = false,
  className,
}: {
  choice: ModelChoice;
  disabled?: boolean;
  /** Overrides on the chip's class, for a smaller composer (Explore). */
  className?: string;
}) {
  const { listing, current } = choice;
  if (!listing || listing.models.length === 0) return null;
  // The visible text, in order, after "Model:" (WCAG 2.5.3, Label in Name):
  // no parentheses, which a checker leaves out when it compares the two.
  const label = current
    ? `Model: ${current.name}, ${current.model || "not configured"}`
    : "Model: no model available";
  return (
    <Menu
      label={label}
      className={cn(COMPOSER_CHIP_CLASS, className)}
      panelClassName="max-w-sm"
      trigger={
        <>
          <Cpu className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
          <span className="truncate">{current?.name ?? "No model"}</span>{" "}
          {current?.model && (
            <span className="hidden shrink-0 text-xs text-muted sm:inline">
              {current.model}
            </span>
          )}
        </>
      }
    >
      <MenuRadioGroup
        label="Model"
        value={current?.id ?? ""}
        onValueChange={(next) => {
          if (!disabled) choice.pick(next);
        }}
      >
        {SCOPES.map(({ scope, label: caption }) => {
          const models = listing.models.filter((m) => m.scope === scope);
          if (models.length === 0) return null;
          return (
            <React.Fragment key={scope}>
              <MenuCaption>{caption}</MenuCaption>
              {models.map((m) => (
                <MenuRadioItem
                  key={m.id}
                  value={m.id}
                  disabled={disabled || m.unavailable !== null}
                  title={m.unavailable ?? undefined}
                  closeOnClick
                >
                  <span className="min-w-0">
                    <span className="block truncate">
                      {m.name}
                      <span className="sr-only">, {caption.toLowerCase()} model</span>
                      {m.id === listing.defaultModel && (
                        <span className="text-xs text-muted"> · default</span>
                      )}
                    </span>
                    <span className="block truncate text-xs text-muted">
                      {m.unavailable ?? m.model}
                    </span>
                  </span>
                </MenuRadioItem>
              ))}
            </React.Fragment>
          );
        })}
      </MenuRadioGroup>
      <MenuSeparator />
      <MenuLink href="/models">Manage models…</MenuLink>
    </Menu>
  );
}
