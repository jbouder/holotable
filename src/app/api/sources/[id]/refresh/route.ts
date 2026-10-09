import { z } from "zod";
import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { json, readJson, route } from "@/lib/http";
import { assertRowFilterSavable } from "@/lib/row-scope";
import { audit } from "@/lib/audit";
import { getSourceById, updateSource } from "@/lib/db/repo";
import { catalogHealth } from "@/lib/catalog/health";
import { serverKind } from "@/lib/sources/server/registry";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z
  .object({
    /** Absent: preview. Present: apply, if the database still matches it. */
    digest: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "invalid digest")
      .optional(),
  })
  .strict();

/**
 * Refresh a source's catalog by introspecting the live schema (source-admin).
 *
 * Two steps on one route (#123). Without a `digest` it is a preview: it
 * introspects, writes nothing, and answers with the diff against the stored
 * catalog and a digest of what it would store. With the digest it introspects
 * again and writes only if the result is the same; if the database changed in
 * between, it answers 409 with the new diff and digest to review instead.
 *
 * Apply is the only writer of the two freshness facts, and it writes both
 * every time: the timestamp that stops the source being reported as never
 * refreshed, and the list of allowlisted tables the database no longer has,
 * which is emptied on the run that finds them again.
 */
export const POST = route(
  "sources.refresh",
  async (req: Request, ctx: RouteContext<"/api/sources/[id]/refresh">) => {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    const source = await getSourceById(id);
    if (!source) throw new HttpError(404, "source not found");

    assertAuthorized(
      identity,
      "source:manage",
      { workspaceId: source.workspaceId },
      { type: "source", id },
    );
    const { digest: confirmed } = await readJson(req, Body);

    const kind = serverKind(source);
    const refresh = await kind.refresh(source);
    const diff = kind.refreshDiff(source, refresh);
    const digest = kind.refreshDigest(refresh);

    if (confirmed === undefined) {
      return json({ diff, digest }, { headers: { "cache-control": "no-store" } });
    }
    if (confirmed !== digest) {
      return json(
        {
          error:
            "The catalog changed since it was reviewed. Review the new changes before applying.",
          kind: "conflict",
          diff,
          digest,
        },
        { status: 409 },
      );
    }

    // A table that lost the filter column would refuse every query on it.
    assertRowFilterSavable(refresh.config);
    const updated = await updateSource(source.workspaceId, id, {
      config: refresh.config,
      catalogRefreshedAt: new Date(),
      catalogMissingTables: refresh.missingTables,
    });
    if (!updated) throw new HttpError(409, "source is tombstoned");
    // Only an applied refresh changes anything; a preview is a read.
    audit({
      actor: identity,
      action: "source.refresh",
      workspaceId: source.workspaceId,
      resource: { type: "source", id },
      detail: { digest, missingTables: refresh.missingTables.length },
    });
    return json({ diff, catalogHealth: catalogHealth(updated) });
  },
);
