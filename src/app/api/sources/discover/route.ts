import { z } from "zod";
import { requireIdentity, assertAuthorized } from "@/lib/auth/authorize";
import { json, readJson, route } from "@/lib/http";
import { audit } from "@/lib/audit";
import { SourceConnection } from "@/lib/registry";
import { SECRET_REF_MESSAGE, SECRET_REF_PATTERN } from "@/lib/secret-refs";
import { requireGrantedSecretRef } from "@/lib/secrets/http";
import { HttpSourceAuth } from "@/lib/sources/http-config";
import { LokiLabel } from "@/lib/sources/kinds/loki";
import {
  duckdbDiscovery,
  lokiDiscovery,
  prometheusDiscovery,
  sqlDiscovery,
} from "@/lib/sources/server/registry";
import { DuckDbConfig, duckdbLayout } from "@/lib/sources/kinds/duckdb";
import {
  MAX_METRICS,
  PrometheusMetric,
  PrometheusUrl,
} from "@/lib/sources/kinds/prometheus";

export const runtime = "nodejs";
export const maxDuration = 30;

// The connection half of a source plus the secret_ref that names its
// credentials. No credential is ever carried here: the server resolves the
// env family itself, and only one granted to this workspace, so a caller can
// only introspect with an account the operator has given their workspace
// (invariant 5).
const SqlBody = z.object({
  /**
   * The kind of the source being drafted. Optional for the bodies sent before
   * there was more than one, which were all TimescaleDB.
   */
  kind: z.literal("timescaledb").default("timescaledb"),
  workspaceId: z.string().min(1).max(128),
  secretRef: z.string().regex(SECRET_REF_PATTERN, SECRET_REF_MESSAGE),
  connection: SourceConnection,
});

/** An HTTP source names a `secret_ref` exactly when its auth needs one. */
function secretRefMatchesAuth(
  b: { auth: "none" | "basic" | "bearer"; secretRef?: string },
  ctx: z.RefinementCtx,
): void {
  if ((b.auth === "none") !== (b.secretRef === undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["secretRef"],
      message:
        b.auth === "none"
          ? 'a source with auth "none" names no secretRef'
          : "secretRef is required: it names where the credentials come from",
    });
  }
}

/**
 * A Prometheus source being drafted (#386): its URL and auth, and the
 * `secret_ref` exactly when the auth needs one. Without `labelsFor` the answer
 * is the metric menu; with it, the label names of those metrics.
 */
const PrometheusBody = z
  .object({
    kind: z.literal("prometheus"),
    workspaceId: z.string().min(1).max(128),
    url: PrometheusUrl,
    auth: HttpSourceAuth,
    secretRef: z.string().regex(SECRET_REF_PATTERN, SECRET_REF_MESSAGE).optional(),
    labelsFor: z.array(PrometheusMetric.shape.name).max(MAX_METRICS).optional(),
  })
  .superRefine(secretRefMatchesAuth);

/**
 * A Loki source being drafted (#563), as a Prometheus one is. Without
 * `valuesFor` the answer is the stream label names; with it, that label's
 * values, as hints. The window is the server's, never the body's.
 */
const LokiBody = z
  .object({
    kind: z.literal("loki"),
    workspaceId: z.string().min(1).max(128),
    url: PrometheusUrl,
    auth: HttpSourceAuth,
    secretRef: z.string().regex(SECRET_REF_PATTERN, SECRET_REF_MESSAGE).optional(),
    valuesFor: LokiLabel.shape.name.optional(),
  })
  .strict()
  .superRefine(secretRefMatchesAuth);

/**
 * A DuckDB source being drafted (#573): its path, relative to
 * `DUCKDB_SOURCES_DIR`, checked by the config's own lexical rules here and
 * resolved by the path guard before anything is opened. No `secret_ref`.
 */
const DuckDbBody = z
  .object({
    kind: z.literal("duckdb"),
    workspaceId: z.string().min(1).max(128),
    path: DuckDbConfig.shape.path,
  })
  .strict();

const Body = z.union([SqlBody, PrometheusBody, LokiBody, DuckDbBody]);
type Body = z.infer<typeof Body>;

/** What one kind's discovery answers, beside `ok: true`. */
type Discover<B> = (body: B) => Promise<Record<string, unknown>>;

/** Each kind's discovery, looked up by the body's kind, never compared with it. */
const DISCOVER: { [K in Body["kind"]]: Discover<Extract<Body, { kind: K }>> } = {
  timescaledb: async (body) => ({
    tables: await sqlDiscovery(body.connection, body.secretRef, body.workspaceId),
  }),
  prometheus: async (body) => {
    const discovery = prometheusDiscovery({
      workspaceId: body.workspaceId,
      url: body.url,
      auth: body.auth,
      secretRef: body.secretRef ?? null,
    });
    const refused = await discovery.checkUrl();
    if (refused) throw new Error(refused);
    return body.labelsFor
      ? { labels: await discovery.labels(body.labelsFor) }
      : { metrics: await discovery.metrics() };
  },
  loki: async (body) => {
    const discovery = lokiDiscovery({
      workspaceId: body.workspaceId,
      url: body.url,
      auth: body.auth,
      secretRef: body.secretRef ?? null,
    });
    const refused = await discovery.checkUrl();
    if (refused) throw new Error(refused);
    return body.valuesFor !== undefined
      ? { values: await discovery.values(body.valuesFor) }
      : { labels: await discovery.labels() };
  },
  duckdb: async (body) => ({
    tables: await duckdbDiscovery(body.path, body.workspaceId).tables(),
  }),
};

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
  if ("secretRef" in body && body.secretRef !== undefined)
    requireGrantedSecretRef(body.secretRef, body.workspaceId);

  // Discovery connects to a server the author named before any source
  // exists, so where it pointed is the part worth keeping (#30).
  const record = (outcome: "success" | "failure") =>
    audit({
      actor: identity,
      action: "source.discover",
      workspaceId: body.workspaceId,
      outcome,
      detail:
        "path" in body
          ? // Which kind of thing it opened, never where: no path in a row.
            { kind: "duckdb", layout: duckdbLayout(body.path) }
          : "url" in body
            ? { url: body.url, auth: body.auth, secretRef: body.secretRef }
            : {
                host: body.connection.host,
                port: body.connection.port,
                database: body.connection.database,
                secretRef: body.secretRef,
              },
    });

  try {
    const answer = await (DISCOVER[body.kind] as Discover<Body>)(body);
    record("success");
    return json({ ok: true, ...answer });
  } catch (err) {
    record("failure");
    return json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
