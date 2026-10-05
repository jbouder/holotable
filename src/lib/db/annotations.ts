import { query } from "@/lib/db/pg";
import {
  ANNOTATIONS_MAX,
  type Annotation,
  type AnnotationInput,
} from "@/lib/annotations";

/**
 * Annotation rows (#68). Every function takes the workspace and every
 * statement filters on it: the caller passes the workspace it authorized,
 * taken from a trusted record, never from the request.
 */

export interface AnnotationStore {
  list(input: {
    workspaceId: string;
    from: Date;
    to: Date;
    tags?: readonly string[];
  }): Promise<Annotation[]>;
  create(input: {
    workspaceId: string;
    createdBy: string;
    annotation: AnnotationInput;
  }): Promise<Annotation>;
  /** Whether a row of that workspace was deleted. */
  remove(input: { workspaceId: string; id: string }): Promise<boolean>;
}

interface Row extends Record<string, unknown> {
  id: string;
  at: Date;
  ended_at: Date | null;
  kind: Annotation["kind"];
  title: string;
  description: string | null;
  tags: string[];
  source: string;
  created_by: string;
}

function toAnnotation(row: Row): Annotation {
  return {
    id: row.id,
    at: new Date(row.at).getTime(),
    ...(row.ended_at ? { endedAt: new Date(row.ended_at).getTime() } : {}),
    kind: row.kind,
    title: row.title,
    ...(row.description ? { description: row.description } : {}),
    tags: row.tags ?? [],
    source: row.source,
    createdBy: row.created_by,
  };
}

const COLUMNS = "id, at, ended_at, kind, title, description, tags, source, created_by";

/** Runs one statement; the app's pool by default, a test's own client otherwise. */
export type RunQuery = <T extends Record<string, unknown>>(
  text: string,
  params: unknown[],
) => Promise<T[]>;

export function makeAnnotationStore(run: RunQuery): AnnotationStore {
  return {
    async list({ workspaceId, from, to, tags }) {
      // Overlapping the window: a range that began before it and is still open
      // in it is drawn, clipped by the chart.
      const rows = await run<Row>(
        `SELECT ${COLUMNS} FROM annotations
       WHERE workspace_id = $1
         AND at < $3
         AND coalesce(ended_at, at) >= $2
         AND ($4::text[] IS NULL OR tags && $4::text[])
       ORDER BY at
       LIMIT ${ANNOTATIONS_MAX}`,
        [workspaceId, from, to, tags && tags.length > 0 ? [...tags] : null],
      );
      return rows.map(toAnnotation);
    },
    async create({ workspaceId, createdBy, annotation }) {
      const [row] = await run<Row>(
        `INSERT INTO annotations
         (workspace_id, at, ended_at, kind, title, description, tags, created_by, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${COLUMNS}`,
        [
          workspaceId,
          annotation.at,
          annotation.endedAt ?? null,
          annotation.kind,
          annotation.title,
          annotation.description ?? null,
          annotation.tags ?? [],
          createdBy,
          annotation.source ?? "manual",
        ],
      );
      return toAnnotation(row);
    },
    async remove({ workspaceId, id }) {
      const rows = await run<{ id: string }>(
        "DELETE FROM annotations WHERE workspace_id = $1 AND id = $2 RETURNING id",
        [workspaceId, id],
      );
      return rows.length > 0;
    },
  };
}

export const pgAnnotationStore: AnnotationStore = makeAnnotationStore(query);
