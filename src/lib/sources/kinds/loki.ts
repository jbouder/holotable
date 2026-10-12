import { z } from "zod";
import { CLAIM_NAME } from "@/lib/auth/claims";
import type { SourceRecord } from "@/lib/registry";
import type { ListingBase } from "@/lib/source-listing";
import { HttpSourceAuth, HttpSourceUrl, LabelName } from "@/lib/sources/http-config";
import type { SourceKind } from "@/lib/sources/types";

/**
 * Loki (#562): any endpoint that answers `/loki/api/v1/*` — Grafana Loki,
 * Grafana Cloud Logs. Panels against it carry LogQL, held to the guard in
 * `src/lib/logql/`.
 *
 * This is what a source of the kind *is* and what may be shown of it; how it
 * is reached is `src/lib/sources/server/loki.ts`. The URL and the auth mode
 * never leave the server: the listing and the editor's catalog name their
 * fields, and neither names those.
 */

/** The allowlist cap, the `MAX_METRICS` of this kind. */
export const MAX_LABELS = 200;
/** The values discovery keeps per label. Hints for the author and the model. */
export const MAX_LABEL_VALUES = 100;

/** A label value as discovery found it: a hint, never compared by the guard. */
export const LokiLabelValue = z
  .string()
  .max(256)
  .refine(
    (v) =>
      ![...v].some((ch) => {
        const code = ch.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      }),
    "must not contain a control character",
  );

/**
 * One allowlisted stream label: every stream selector must carry an `=`
 * matcher on at least one of these (`src/lib/logql/safety.ts`).
 */
export const LokiLabel = z
  .object({
    name: LabelName.refine((v) => !v.startsWith("__"), "must not be a reserved label"),
    /** The values discovery found; hints, never refusals. */
    values: z.array(LokiLabelValue).max(MAX_LABEL_VALUES).default([]),
  })
  .strict();
export type LokiLabel = z.infer<typeof LokiLabel>;

/** A tenant label (#31): every stream selector is narrowed to `label="<claim value>"`. */
export const LokiRowFilter = z
  .object({
    label: LabelName.refine((v) => !v.startsWith("__"), "must not be a reserved label"),
    claim: z.string().regex(CLAIM_NAME, "must be a claim name"),
  })
  .strict();

export const LokiConfig = z
  .object({
    kind: z.literal("loki"),
    url: HttpSourceUrl,
    /** `none`, `basic` or `bearer`; see `HttpSourceAuth`. */
    auth: HttpSourceAuth,
    /** The label allowlist. Only these labels may anchor a stream selector. */
    labels: z
      .array(LokiLabel)
      .min(1)
      .max(MAX_LABELS)
      .refine(
        (labels) => new Set(labels.map((l) => l.name)).size === labels.length,
        "each label is listed once",
      ),
    rowFilter: LokiRowFilter.optional(),
  })
  .strict();
export type LokiConfig = z.infer<typeof LokiConfig>;

/**
 * What the editor may see: the label allowlist with its value hints, never
 * where it lives. The shape the LogQL guard reads (`LogqlCatalog`).
 */
export interface LokiCatalog {
  labels: { name: string; values: string[] }[];
}

/** A Loki source (#562): never its URL or its auth mode. */
export interface LokiListing extends ListingBase {
  kind: "loki";
  labelCount: number;
}

function configOf(source: SourceRecord): LokiConfig {
  const cfg = source.config;
  if (cfg.kind !== "loki") throw new Error(`${source.id} is not a Loki source`);
  return cfg;
}

export const loki = {
  kind: "loki",
  label: "Loki",
  language: "logql",
  config: LokiConfig,

  connection(cfg: LokiConfig): { url: string; auth: LokiConfig["auth"] } {
    return { url: cfg.url, auth: cfg.auth };
  },

  catalog(cfg: LokiConfig): LokiCatalog {
    return {
      labels: cfg.labels.map((l) => ({ name: l.name, values: [...l.values] })),
    };
  },

  listing(source: SourceRecord): LokiListing {
    return {
      id: source.id,
      workspaceId: source.workspaceId,
      name: source.name,
      kind: "loki",
      labelCount: configOf(source).labels.length,
      tombstonedAt: source.tombstonedAt,
    };
  },

  rowFilter(cfg: LokiConfig) {
    return cfg.rowFilter
      ? { target: cfg.rowFilter.label, claim: cfg.rowFilter.claim }
      : undefined;
  },
} as const satisfies SourceKind<"loki", typeof LokiConfig, LokiCatalog, LokiListing>;
