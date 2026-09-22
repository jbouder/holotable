import { test } from "node:test";
import assert from "node:assert/strict";
import type { CatalogHealth } from "@/lib/catalog/health";
import {
  noSourceGuidance,
  onboardingState,
  type OnboardingFacts,
  type OnboardingStepId,
} from "@/lib/onboarding";

/** A catalog verdict, blocked or not — the only thing the flow reads. */
function catalog(blocked: boolean): CatalogHealth {
  return {
    state: blocked ? "never_refreshed" : "ok",
    blocked,
    missingTables: [],
    liveTableCount: blocked ? 0 : 3,
    refreshedAt: blocked ? null : "2026-09-22T00:00:00.000Z",
    ageDays: blocked ? null : 0,
  };
}

/** A source-admin who is also an editor: the operator setting an install up. */
function facts(overrides: Partial<OnboardingFacts> = {}): OnboardingFacts {
  return {
    sources: [],
    dashboardCount: 0,
    canManageSources: true,
    canCreateDashboards: true,
    ...overrides,
  };
}

function statuses(f: OnboardingFacts): Record<OnboardingStepId, string> {
  const out = {} as Record<OnboardingStepId, string>;
  for (const step of onboardingState(f).steps) out[step.id] = step.status;
  return out;
}

test("a fresh install has all three steps ahead of it", () => {
  const state = onboardingState(facts());
  assert.deepEqual(
    state.steps.map((s) => s.id),
    ["connect", "verify", "generate"],
  );
  assert.deepEqual(statuses(facts()), {
    connect: "current",
    verify: "todo",
    generate: "todo",
  });
  assert.equal(state.doneCount, 0);
  assert.equal(state.currentStepId, "connect");
  assert.equal(state.complete, false);
});

test("registering a source completes only the first step", () => {
  // The catalog has never been refreshed, so nothing can be generated yet.
  assert.deepEqual(statuses(facts({ sources: [{ catalog: catalog(true) }] })), {
    connect: "done",
    verify: "current",
    generate: "todo",
  });
});

test("verify tracks the same verdict generation refuses on", () => {
  const blockedOnly = facts({ sources: [{ catalog: catalog(true) }] });
  assert.equal(onboardingState(blockedOnly).steps[1].status, "current");

  // One usable source among several unusable ones is enough: the step is
  // "can anything be queried", not "is everything healthy".
  const oneGood = facts({
    sources: [{ catalog: catalog(true) }, { catalog: catalog(false) }],
  });
  assert.equal(onboardingState(oneGood).steps[1].status, "done");
  assert.equal(onboardingState(oneGood).currentStepId, "generate");
});

test("a saved dashboard completes the flow", () => {
  const state = onboardingState(
    facts({ sources: [{ catalog: catalog(false) }], dashboardCount: 1 }),
  );
  assert.equal(state.doneCount, 3);
  assert.equal(state.currentStepId, null);
  assert.equal(state.complete, true);
  assert.equal(state.actionable, false);
});

test("a step already done stays done even if a later one is not", () => {
  // A dashboard exists but its source has since stopped resolving. Progress is
  // per step, not a furthest-point-reached, so step 3 does not un-complete.
  const state = onboardingState(
    facts({ sources: [{ catalog: catalog(true) }], dashboardCount: 2 }),
  );
  assert.deepEqual(
    state.steps.map((s) => s.status),
    ["done", "current", "done"],
  );
  assert.equal(state.currentStepId, "verify");
  assert.equal(state.complete, false);
});

test("a viewer is never told to create a source or a dashboard", () => {
  const state = onboardingState(
    facts({ canManageSources: false, canCreateDashboards: false }),
  );
  assert.equal(state.actionable, false);
  for (const step of state.steps) {
    assert.equal(step.action, null, `${step.id} offered an action to a viewer`);
    assert.match(String(step.waitingOn), /role/);
  }
});

test("an editor without source-admin is told who to ask, and can still generate", () => {
  const state = onboardingState(
    facts({ canManageSources: false, canCreateDashboards: true }),
  );
  const [connect, verify, generate] = state.steps;
  assert.equal(connect.action, null);
  assert.match(String(connect.waitingOn), /source-admin/);
  assert.equal(verify.action, null);
  assert.deepEqual(generate.action, { label: "New dashboard", href: "/dashboards/new" });
  assert.equal(generate.waitingOn, null);
  // Something is actionable, so the flow is worth drawing even here.
  assert.equal(state.actionable, true);
});

test("every step offers an action or names who can, never both and never neither", () => {
  for (const canManageSources of [true, false]) {
    for (const canCreateDashboards of [true, false]) {
      const state = onboardingState(facts({ canManageSources, canCreateDashboards }));
      for (const step of state.steps) {
        assert.equal(
          (step.action === null) !== (step.waitingOn === null),
          true,
          `${step.id} had action=${JSON.stringify(step.action)} waitingOn=${step.waitingOn}`,
        );
      }
    }
  }
});

test("the connect step lands on the form, not on a page with a button", () => {
  const [connect] = onboardingState(facts()).steps;
  assert.deepEqual(connect.action, {
    label: "Add a data source",
    href: "/data-sources?new=1",
  });
});

test("the no-source empty state follows the same role rule", () => {
  const allowed = noSourceGuidance(true);
  assert.deepEqual(allowed.action, {
    label: "Add a data source",
    href: "/data-sources?new=1",
  });

  const denied = noSourceGuidance(false);
  assert.equal(denied.action, null);
  assert.match(denied.body, /source-admin/);
  // Same heading either way: only the offer changes.
  assert.equal(denied.title, allowed.title);
});
