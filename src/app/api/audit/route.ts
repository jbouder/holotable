import { requireIdentity } from "@/lib/auth/authorize";
import { json, route } from "@/lib/http";
import { parseAuditQuery } from "@/lib/audit-query";
import { listAuditLog } from "@/lib/db/repo";

export const runtime = "nodejs";

/**
 * Read the audit log (#30), newest first.
 *
 * `?workspaceId=&from=&to=&action=&outcome=&limit=&before=`. `from` and `to`
 * take an ISO timestamp or a relative expression (`now-24h`) and are resolved
 * here, on the server. A page holds `limit` rows (100 by default, 500 at most);
 * `next` is the `before` that fetches the page after it, and is null on the
 * last one.
 *
 * Gated on `source:manage`, scoped as `auditScope` describes: a workspace
 * source-admin reads their own workspaces' rows and `?workspaceId=` only
 * narrows that, so anyone else gets an empty list rather than a 403 that would
 * confirm a workspace exists. A platform admin reads any workspace, and with
 * no filter every row, sign-ins and sign-outs included.
 *
 * There is no write, update or delete here or anywhere else: rows come only
 * from `audit()`, and the table refuses changes to them.
 */
export const GET = route("audit", async (req: Request) => {
  const identity = await requireIdentity();
  const q = parseAuditQuery(identity, new URL(req.url).searchParams);
  const entries = await listAuditLog(q);
  const next = entries.length === q.limit ? (entries.at(-1)?.id ?? null) : null;
  return json({ entries, next }, { headers: { "cache-control": "no-store" } });
});
