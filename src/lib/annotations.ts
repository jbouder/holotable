import { z } from "zod";
import type { ColorToken } from "@/lib/panels/colors";

/**
 * Annotations (#68): an event drawn on the time-series panels of a workspace's
 * dashboards, so a spike can be read against the deploy or incident behind it.
 *
 * Browser-safe: the shapes, and what a chart draws for them. Reading and
 * writing them is `src/lib/db/annotations.ts`, and the routes authorize every
 * read against a dashboard's own workspace and every write against the
 * workspace in the path.
 */

export const ANNOTATION_KINDS = ["deploy", "incident", "note"] as const;
export const AnnotationKind = z.enum(ANNOTATION_KINDS);
export type AnnotationKind = z.infer<typeof AnnotationKind>;

/** Each kind's color, as a token (invariant 13). */
export const ANNOTATION_COLORS: Record<AnnotationKind, ColorToken> = {
  deploy: "info",
  incident: "danger",
  note: "neutral",
};

const Tag = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9_.:-]+$/, "a tag is letters, digits and _ . : -");

/** An ISO-8601 instant. Display data: it never sets a panel's window. */
const Instant = z.iso.datetime({ offset: true });

/** What a person or a pipeline writes. */
export const AnnotationInput = z
  .object({
    at: Instant,
    /** A range when set: an incident, a maintenance window. */
    endedAt: Instant.optional(),
    kind: AnnotationKind,
    title: z.string().trim().min(1).max(200),
    description: z.string().max(2_000).optional(),
    tags: z.array(Tag).max(10).optional(),
    /** Where it came from: a pipeline's name. `manual` from the dashboard. */
    source: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_.:-]+$/)
      .optional(),
  })
  .strict()
  .refine((a) => !a.endedAt || Date.parse(a.endedAt) >= Date.parse(a.at), {
    message: "endedAt must not be before at",
    path: ["endedAt"],
  });
export type AnnotationInput = z.infer<typeof AnnotationInput>;

/** One stored annotation, as the API returns it. */
export interface Annotation {
  id: string;
  /** Epoch ms. */
  at: number;
  endedAt?: number;
  kind: AnnotationKind;
  title: string;
  description?: string;
  tags: string[];
  source: string;
  createdBy: string;
}

/**
 * Which annotations a dashboard shows: none when it turns them off, and only
 * those carrying one of its tags when it names any.
 */
export const DashboardAnnotations = z
  .object({
    /** Draw annotations on this dashboard. On by default. */
    show: z.boolean().optional(),
    /** Only annotations with at least one of these tags. */
    tags: z.array(Tag).max(10).optional(),
  })
  .strict();
export type DashboardAnnotations = z.infer<typeof DashboardAnnotations>;

/** The most annotations one window returns. */
export const ANNOTATIONS_MAX = 500;

/** Untrusted JSON from the API as annotations, dropping anything malformed. */
export function readAnnotations(value: unknown): Annotation[] {
  const list =
    typeof value === "object" && value !== null && "annotations" in value
      ? (value as { annotations: unknown }).annotations
      : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap((a): Annotation[] => {
    if (typeof a !== "object" || a === null) return [];
    const r = a as Record<string, unknown>;
    if (
      typeof r.id !== "string" ||
      typeof r.at !== "number" ||
      typeof r.title !== "string" ||
      !AnnotationKind.safeParse(r.kind).success
    ) {
      return [];
    }
    return [
      {
        id: r.id,
        at: r.at,
        endedAt: typeof r.endedAt === "number" ? r.endedAt : undefined,
        kind: r.kind as AnnotationKind,
        title: r.title,
        description: typeof r.description === "string" ? r.description : undefined,
        tags: Array.isArray(r.tags) ? r.tags.filter((t) => typeof t === "string") : [],
        source: typeof r.source === "string" ? r.source : "manual",
        createdBy: typeof r.createdBy === "string" ? r.createdBy : "",
      },
    ];
  });
}
