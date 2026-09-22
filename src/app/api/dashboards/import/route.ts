import { z } from "zod";
import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { readJson, json, route } from "@/lib/http";
import { listSources, createDashboard } from "@/lib/db/repo";
import { resolveAndValidateDashboard } from "@/lib/dashboard-service";
import {
  DashboardExportFile,
  SourceMapping,
  remapSourceIds,
  unresolvedSourceIds,
} from "@/lib/dashboard-export";

export const runtime = "nodejs";

/**
 * A spec caps at 50 panels of 8 000 SQL characters, so a legitimate file is a
 * few hundred kilobytes at the very worst. The cap is generous against that
 * and still small enough that a hostile upload is refused rather than buffered.
 */
const MAX_IMPORT_BYTES = 1_048_576;

/** A mapping bigger than the panel cap could not describe a valid spec. */
const MAX_MAPPING_ENTRIES = 50;

const ImportBody = z
  .object({
    /**
     * The target workspace. Supplied by the request because the file cannot
     * name one — it was written somewhere else — and re-checked by `can()`
     * below, which is what keeps it a request for a workspace rather than a
     * claim to one.
     */
    workspaceId: z.string().min(1).max(128),
    file: DashboardExportFile,
    sourceMapping: SourceMapping.refine(
      (m) => Object.keys(m).length <= MAX_MAPPING_ENTRIES,
      `at most ${MAX_MAPPING_ENTRIES} source mappings`,
    ).default({}),
  })
  .strict();

/**
 * Create a dashboard at version 1 from an exported file.
 *
 * An uploaded file is untrusted input and is treated as such at every step:
 *
 * - The envelope and the spec are parsed by the same strict schemas everything
 *   else uses, so a wrong shape or an unknown field is a 400 and never a
 *   partially applied import.
 * - Source ids are re-pointed by the EXPLICIT mapping in the request, never
 *   guessed from names or catalogs, and the result is resolved against the
 *   target workspace's live sources. Anything still unresolved refuses the
 *   whole import and names the ids, rather than creating a dashboard whose
 *   panels would all fail.
 * - Authorization is `dashboard:create` on the target workspace, decided from
 *   the identity's groups. The file contributes nothing to that decision.
 * - `resolveAndValidateDashboard` then re-validates every statement against
 *   its source catalog and derives the workspace from the trusted source
 *   records, exactly as a create or a save does.
 */
export const POST = route("dashboards.import", async (req: Request) => {
  const identity = await requireIdentity();
  const body = await readJson(req, ImportBody, { maxBytes: MAX_IMPORT_BYTES });

  assertAuthorized(identity, "dashboard:create", { workspaceId: body.workspaceId });

  const spec = remapSourceIds(body.file.spec, body.sourceMapping);

  // Scoped to the target workspace and to untombstoned sources, so a source
  // that exists elsewhere reads exactly as one that does not exist at all.
  const available = await listSources(body.workspaceId);
  const unresolved = unresolvedSourceIds(
    spec,
    available.map((s) => s.id),
  );
  if (unresolved.length > 0) {
    throw new HttpError(
      400,
      `${body.workspaceId} has no source named ${unresolved.join(", ")}` +
        " — map each one to a source in this workspace and import again",
    );
  }

  const { workspaceId } = await resolveAndValidateDashboard(spec);
  if (workspaceId !== body.workspaceId) {
    // Unreachable via the check above (that list is workspace-scoped), and
    // kept because it is the assertion that actually states the invariant: the
    // dashboard is created in the workspace its sources belong to.
    throw new HttpError(400, "panels reference a different workspace");
  }

  const record = await createDashboard({
    workspaceId,
    createdBy: identity.sub,
    spec,
  });
  return json({ dashboard: record }, { status: 201 });
});
