import { z } from "zod";
import { assertAuthorized, HttpError, requireIdentity } from "@/lib/auth/authorize";
import { audit } from "@/lib/audit";
import { getSourceById } from "@/lib/db/repo";
import { json, readJson, route } from "@/lib/http";
import { Variable, queryStatement } from "@/lib/ir";
import { rowFilterHttpError, rowScopeFor } from "@/lib/row-scope";
import { VariableSelectionError } from "@/lib/variable-selection";
import { variableOptions } from "@/lib/variables";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.object({ variable: Variable });

/**
 * The values a variable allows, for the editor (#67): the dashboard being
 * edited may not be saved yet, so this takes the declaration itself. An
 * `enum` answers from its own list. A `query` variable's SELECT runs exactly
 * as it will for a viewer (guarded, no time filter, the caller's rows), after
 * authorizing the caller to generate against its source's workspace, which is
 * what running a preview query takes.
 */
export const POST = route("variables.options", async (req: Request) => {
  const identity = await requireIdentity();
  const { variable } = await readJson(req, Body);
  if (!variable.query) return json({ options: variable.values ?? [] });

  const source = await getSourceById(variable.query.sourceId);
  if (!source || source.tombstonedAt)
    throw new HttpError(400, "unknown or removed source");
  assertAuthorized(
    identity,
    "dashboard:generate",
    { workspaceId: source.workspaceId },
    { type: "source", id: source.id },
  );
  const record = (outcome: "success" | "failure") =>
    audit({
      actor: identity,
      action: "query.execute",
      workspaceId: source.workspaceId,
      resource: { type: "source", id: source.id },
      outcome,
      detail: {
        via: "variable",
        variable: variable.name,
        ...(variable.query ? queryStatement(variable.query) : {}),
      },
    });
  const scope = rowScopeFor(identity, [source]);
  try {
    const options = await variableOptions(variable, source.workspaceId, scope);
    record("success");
    return json({ options });
  } catch (err) {
    record("failure");
    // The author's to fix, and said as the stream would say it.
    if (err instanceof VariableSelectionError) {
      throw new HttpError(400, err.message, {}, "statement");
    }
    throw rowFilterHttpError(err);
  }
});
