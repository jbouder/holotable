"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Check, ExternalLink, Lock } from "lucide-react";
import {
  FIRST_DASHBOARD_DOCS_URL,
  type OnboardingState,
  type OnboardingStep,
} from "@/lib/onboarding";
import { SETUP_DISMISSED_COOKIE } from "@/lib/dismissals";
import { dismissHint } from "@/components/onboarding/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * The guided first-run flow, shown in place of an empty dashboard list.
 *
 * It replaces a list, it does not gate one: every route stays reachable from
 * the nav bar while this is on screen, dismissing it is one click, and bringing
 * it back is one more. The progress it shows is computed on the server from the
 * workspace itself (see `src/lib/onboarding.ts`), so nothing here decides
 * whether a step is done — it only draws it.
 */
export function FirstRun({
  state,
  dismissed: initiallyDismissed,
}: {
  state: OnboardingState;
  /** Read from the cookie on the server, so a dismissed flow never flashes. */
  dismissed: boolean;
}) {
  const [dismissed, setLocalDismissed] = React.useState(initiallyDismissed);

  // Applied locally first and persisted in the background: the cookie only has
  // to be right by the next render of this page, and a dismissal that waited on
  // a round trip would feel like a broken button.
  function dismiss(next: boolean) {
    setLocalDismissed(next);
    void dismissHint(SETUP_DISMISSED_COOKIE, next);
  }

  // Nothing this caller can act on — a viewer on an install that is still being
  // set up. Three buttons they cannot press would be worse than one sentence.
  if (!state.actionable) {
    return (
      <EmptyState
        icon={<Lock className="h-6 w-6" />}
        title="Nothing to show yet"
        description={
          state.steps.find((step) => step.status !== "done")?.waitingOn ??
          "No dashboards have been created in your workspaces yet."
        }
      />
    );
  }

  if (dismissed) {
    // The generate step decides whether the primary button is offered: a
    // source-admin who is not an editor can finish setting the install up and
    // still may not create the dashboard, and handing them a link that comes
    // back 403 is the thing the role rule exists to prevent.
    const generate = state.steps.find((step) => step.id === "generate");
    return (
      <EmptyState
        title="No dashboards yet"
        description="Describe the dashboard you want in plain English and the model writes the spec; the server runs the SQL."
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            {generate?.action && (
              <Link href={generate.action.href}>
                <Button>{generate.action.label}</Button>
              </Link>
            )}
            <Button variant="ghost" onClick={() => dismiss(false)}>
              Show the setup guide
            </Button>
          </div>
        }
      />
    );
  }

  // Left-aligned with the page header rather than centred under it: on a wide
  // screen a centred column reads as a modal floating over an empty page.
  return (
    <div className="space-y-4">
      <div className="max-w-prose">
        <h2 className="text-xl font-semibold">Welcome to Holotable</h2>
        <p className="mt-1 text-sm text-muted">
          Three steps to a live dashboard. Progress is read from your workspace, so you
          can leave at any point and pick up where you stopped.
        </p>
        <p className="mt-2 text-xs text-muted">
          Step {Math.min(state.doneCount + 1, state.steps.length)} of {state.steps.length}
        </p>
      </div>

      <div className="max-w-5xl space-y-4">
        <ol className="space-y-3">
          {state.steps.map((step, index) => (
            <li key={step.id}>
              <StepCard step={step} index={index} />
            </li>
          ))}
        </ol>

        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <a
            href={FIRST_DASHBOARD_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-muted hover:text-foreground"
          >
            Read the walkthrough <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <Button variant="ghost" size="sm" onClick={() => dismiss(true)}>
            Skip for now
          </Button>
        </div>
      </div>
    </div>
  );
}

function StepCard({ step, index }: { step: OnboardingStep; index: number }) {
  const current = step.status === "current";
  return (
    <Card className={current ? "border-primary/50" : undefined}>
      <CardContent className="flex items-start gap-3">
        <StepMarker status={step.status} index={index} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={
                step.status === "done"
                  ? "font-medium text-muted line-through"
                  : "font-medium"
              }
            >
              {step.title}
            </span>
            {step.status === "done" && <span className="text-xs text-success">Done</span>}
          </div>
          <p className="mt-1 text-sm text-muted">{step.detail}</p>
          {step.status !== "done" &&
            (step.action ? (
              <Link href={step.action.href} className="mt-3 inline-block">
                <Button variant={current ? "primary" : "secondary"} size="sm">
                  {step.action.label} <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            ) : (
              <p className="mt-3 flex items-start gap-1.5 text-xs text-muted">
                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {step.waitingOn}
              </p>
            ))}
        </div>
      </CardContent>
    </Card>
  );
}

function StepMarker({
  status,
  index,
}: {
  status: OnboardingStep["status"];
  index: number;
}) {
  const base =
    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold";
  if (status === "done") {
    return (
      <span className={`${base} border-success/40 text-success`} aria-hidden="true">
        <Check className="h-3.5 w-3.5" />
      </span>
    );
  }
  return (
    <span
      className={`${base} ${
        status === "current"
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border text-muted"
      }`}
      aria-hidden="true"
    >
      {index + 1}
    </span>
  );
}
