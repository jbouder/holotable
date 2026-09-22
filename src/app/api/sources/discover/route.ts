import { z } from "zod";
import { requireIdentity, assertAuthorized } from "@/lib/auth/authorize";
import { json, readJson, route } from "@/lib/http";
import { SourceConnection } from "@/lib/registry";
import { discoverTables } from "@/lib/timescaledb/catalog";

export const runtime = "nodejs";
export const maxDuration = 30;

// The connection half of a source plus the secret_ref that names its
// credentials. No credential is ever carried here: the server resolves the
// env family itself, so a caller can only introspect databases the operator
// has already configured an account for (invariant 5).
const Body = z.object({
  workspaceId: z.string().min(1).max(128),
  secretRef: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/, "secretRef must be an UPPER_SNAKE env family"),
  connection: SourceConnection,
});

/**
 * List the tables and columns a prospective source's read-only user can see,
 * so an author can pick an allowlist instead of typing one.
 *
 * Authorization mirrors source creation: `source:manage` on the target
 * workspace, taken from the request and validated against the caller's
 * identity, never granted by naming a workspace. This introspects a database
 * that does not have a source record yet, which is why it takes the connection
 * rather than an id — the caller is already authorized to create exactly such
 * a source, so it opens no door that `POST /api/sources` did not.
 *
 * What comes back is a *menu*, not an allowlist. Nothing here is persisted and
 * nothing widens what generated SQL may reference until the author selects a
 * table and the create/update route validates the resulting `SourceConfig`.
 *
 * A connection or credential failure is a **200** carrying `{ok:false,error}`,
 * the same shape `POST /api/sources/[id]/test` uses and for the same reason:
 * the author typed the host, the port and the `secret_ref`, so the message is
 * theirs to act on rather than an infrastructure failure to make opaque.
 */
export const POST = route("sources.discover", async (req: Request) => {
  const identity = await requireIdentity();
  const body = await readJson(req, Body);

  assertAuthorized(identity, "source:manage", { workspaceId: body.workspaceId });

  try {
    const tables = await discoverTables(body.connection, body.secretRef);
    return json({ ok: true, tables });
  } catch (err) {
    return json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
