import assert from "node:assert/strict";
import type { SourcePlan } from "@/lib/sources/server/types";
import type { ExecutablePlan } from "@/lib/sql/safety";

/** A kind's plan as the SQL plan it must be, for a test about a SQL source. */
export function sqlPlanOf(plan: SourcePlan): ExecutablePlan {
  assert.equal(plan.language, "sql");
  if (plan.language !== "sql") throw new Error("not a SQL plan");
  return plan.plan;
}
