import { z } from "zod";
import { CLAIM_NAME } from "@/lib/auth/claims";
import type { SourceRecord } from "@/lib/registry";
import type { PrometheusListing } from "@/lib/source-listing";
import type { SourceKind } from "@/lib/sources/types";

/**
 * Prometheus (#385): any endpoint that answers the Prometheus HTTP API —
 * Prometheus, Thanos, Mimir, VictoriaMetrics, Grafana Cloud. Panels against
 * it carry PromQL, held to the guard in `src/lib/promql/`.
 *
 * This is what a source of the kind *is* and what may be shown of it; how it
 * is reached is `src/lib/sources/server/prometheus.ts`. The URL and the auth
 * mode never leave the server: the listing and the editor's catalog name
 * their fields, and neither names those.
 */

/** The allowlist cap, the `MAX_TABLES` of this kind. */
export const MAX_METRICS = 200;
export const MAX_LABELS = 64;

const LabelName = z
  .string()
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a label name");

export const PrometheusMetric = z
  .object({
    /** The metric's name, compared exactly by the guard. */
    name: z
      .string()
      .min(1)
      .max(256)
      .refine(
        (v) =>
          ![...v].some((ch) => {
            const code = ch.charCodeAt(0);
            return ch === '"' || ch === "\\" || code < 0x20 || code === 0x7f;
          }),
        "must not contain a quote, a backslash or a control character",
      ),
    type: z
      .enum(["counter", "gauge", "histogram", "summary", "unknown"])
      .default("unknown"),
    help: z.string().max(500).optional(),
    /** The labels its series carry, as discovered; hints, never refusals. */
    labels: z.array(LabelName).max(MAX_LABELS).default([]),
  })
  .strict();
export type PrometheusMetric = z.infer<typeof PrometheusMetric>;

/**
 * The endpoint's address: http(s), no credentials, no query or fragment. A
 * path is a prefix, for an API not at the root
 * (`https://vm.example/select/0/prometheus`). Whether the host may be reached
 * at all is the server's to say, against `SOURCE_URL_ALLOWLIST`.
 */
export const PrometheusUrl = z
  .string()
  .max(2048)
  .refine((raw) => {
    try {
      const url = new URL(raw);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, "must be an http(s) URL with no credentials, query or fragment");

/** A tenant label (#31): every selector is narrowed to `label="<claim value>"`. */
export const PrometheusRowFilter = z
  .object({
    label: LabelName.refine((v) => !v.startsWith("__"), "must not be a reserved label"),
    claim: z.string().regex(CLAIM_NAME, "must be a claim name"),
  })
  .strict();

export const PrometheusConfig = z
  .object({
    kind: z.literal("prometheus"),
    url: PrometheusUrl,
    /**
     * `none` is for an endpoint with no authentication, typically in the
     * cluster; such a source names no `secret_ref`. `basic` resolves
     * `<REF>_USERNAME`/`<REF>_PASSWORD`, `bearer` resolves `<REF>_TOKEN`.
     */
    auth: z.enum(["none", "basic", "bearer"]),
    /** The metric allowlist. Only these metrics may be named by any PromQL. */
    metrics: z.array(PrometheusMetric).min(1).max(MAX_METRICS),
    rowFilter: PrometheusRowFilter.optional(),
  })
  .strict();
export type PrometheusConfig = z.infer<typeof PrometheusConfig>;

/** What the editor may see: the metric allowlist, never where it lives. */
export interface PrometheusCatalog {
  metrics: {
    name: string;
    type: PrometheusMetric["type"];
    help?: string;
    labels: string[];
  }[];
}

function configOf(source: SourceRecord): PrometheusConfig {
  const cfg = source.config;
  if (cfg.kind !== "prometheus")
    throw new Error(`${source.id} is not a Prometheus source`);
  return cfg;
}

export const prometheus = {
  kind: "prometheus",
  label: "Prometheus",
  language: "promql",
  config: PrometheusConfig,

  connection(cfg: PrometheusConfig): { url: string; auth: PrometheusConfig["auth"] } {
    return { url: cfg.url, auth: cfg.auth };
  },

  catalog(cfg: PrometheusConfig): PrometheusCatalog {
    return {
      metrics: cfg.metrics.map((m) => ({
        name: m.name,
        type: m.type,
        ...(m.help ? { help: m.help } : {}),
        labels: [...m.labels],
      })),
    };
  },

  listing(source: SourceRecord): PrometheusListing {
    return {
      id: source.id,
      workspaceId: source.workspaceId,
      name: source.name,
      kind: "prometheus",
      metricCount: configOf(source).metrics.length,
      tombstonedAt: source.tombstonedAt,
    };
  },

  rowFilter(cfg: PrometheusConfig) {
    return cfg.rowFilter
      ? { target: cfg.rowFilter.label, claim: cfg.rowFilter.claim }
      : undefined;
  },
} as const satisfies SourceKind<
  "prometheus",
  typeof PrometheusConfig,
  PrometheusCatalog,
  PrometheusListing
>;
