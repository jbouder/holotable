import type { Panel } from "@/lib/ir";

/**
 * Field- and line-level diff between the panel being edited and the one a
 * natural-language edit produced.
 *
 * A generated panel used to replace the current one the moment the model
 * finished streaming, so a one-word prompt could discard hand-tuned SQL with no
 * confirmation and no trace. Generation now lands in a pending slot and the
 * author accepts or rejects it, which needs a readable answer to "what would
 * change?" — that answer is computed here, as pure functions over two panels,
 * so the editor component stays presentational.
 *
 * The `after` side is a deep-partial on purpose: the same diff renders while
 * the object is still streaming, with fields that have not arrived yet marked
 * `pending` rather than reported as changes.
 */

/** A panel as the model has produced it so far. */
export interface PanelDraft {
  id?: string;
  title?: string;
  description?: string;
  viz?: Panel["viz"];
  format?: Panel["format"];
  query?: { sourceId?: string; sql?: string; timeField?: string };
  layout?: { x?: number; y?: number; w?: number; h?: number };
}

export interface FieldDiff {
  /** Stable key, also the React key. */
  key: string;
  label: string;
  before: string;
  after: string;
  changed: boolean;
  /** The generation has not produced this field yet (streaming only). */
  pending: boolean;
}

export type SqlLineKind = "context" | "add" | "remove";

export interface SqlLine {
  kind: SqlLineKind;
  /** 1-based line number on each side; null where the line does not exist. */
  before: number | null;
  after: number | null;
  text: string;
}

export interface SqlDiff {
  changed: boolean;
  added: number;
  removed: number;
  lines: SqlLine[];
}

export interface PanelDiff {
  /** Every comparable field, changed or not — the view collapses the rest. */
  fields: FieldDiff[];
  changedFields: number;
  sql: SqlDiff;
  /** Nothing the author would see would change. */
  identical: boolean;
}

/**
 * Beyond this many lines on either side the quadratic LCS stops being worth
 * it, and a SELECT that long is not something anyone reads line by line
 * either: the whole block is reported as replaced.
 */
const MAX_DIFF_LINES = 400;

const NONE = "none";

function splitLines(sql: string): string[] {
  return sql.replace(/\n+$/, "").split(/\r?\n/);
}

/** Longest common subsequence of two line arrays, as a line-level diff. */
export function diffSqlLines(before: string, after: string): SqlDiff {
  if (before === after) {
    return {
      changed: false,
      added: 0,
      removed: 0,
      lines: splitLines(before).map((text, i) => ({
        kind: "context" as const,
        before: i + 1,
        after: i + 1,
        text,
      })),
    };
  }

  const a = splitLines(before);
  const b = splitLines(after);

  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return {
      changed: true,
      added: b.length,
      removed: a.length,
      lines: [
        ...a.map((text, i) => ({
          kind: "remove" as const,
          before: i + 1,
          after: null,
          text,
        })),
        ...b.map((text, i) => ({
          kind: "add" as const,
          before: null,
          after: i + 1,
          text,
        })),
      ],
    };
  }

  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const lines: SqlLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: "context", before: i + 1, after: j + 1, text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      lines.push({ kind: "remove", before: i + 1, after: null, text: a[i] });
      removed++;
      i++;
    } else {
      lines.push({ kind: "add", before: null, after: j + 1, text: b[j] });
      added++;
      j++;
    }
  }
  for (; i < a.length; i++) {
    lines.push({ kind: "remove", before: i + 1, after: null, text: a[i] });
    removed++;
  }
  for (; j < b.length; j++) {
    lines.push({ kind: "add", before: null, after: j + 1, text: b[j] });
    added++;
  }

  return { changed: added > 0 || removed > 0, added, removed, lines };
}

function formatLayout(layout: Panel["layout"]): string {
  return `x ${layout.x} · y ${layout.y} · w ${layout.w} · h ${layout.h}`;
}

interface FieldSpec {
  key: string;
  label: string;
  /** The value on the current panel, rendered. */
  before: string;
  /** The generated value, or undefined when it has not been produced. */
  after: string | undefined;
}

/**
 * Compare the current panel with a generated one.
 *
 * While `streaming`, a field the model has not emitted yet is `pending` and
 * never counts as a change; once the object is final, an absent optional field
 * is a real removal and is reported as such.
 */
export function diffPanels(
  before: Panel,
  after: PanelDraft,
  opts: { streaming?: boolean } = {},
): PanelDiff {
  const streaming = opts.streaming === true;
  const layout = after.layout;
  const specs: FieldSpec[] = [
    { key: "title", label: "Title", before: before.title, after: after.title },
    {
      key: "description",
      label: "Description",
      before: before.description ?? NONE,
      after:
        streaming && after.description === undefined
          ? undefined
          : (after.description ?? NONE),
    },
    { key: "viz", label: "Visualization", before: before.viz, after: after.viz },
    {
      key: "format",
      label: "Format",
      before: before.format ?? NONE,
      after: streaming && after.format === undefined ? undefined : (after.format ?? NONE),
    },
    {
      key: "sourceId",
      label: "Source",
      before: before.query.sourceId,
      after: after.query?.sourceId,
    },
    {
      key: "timeField",
      label: "Time field",
      before: before.query.timeField ?? NONE,
      after:
        streaming && after.query?.timeField === undefined
          ? undefined
          : (after.query?.timeField ?? NONE),
    },
    {
      key: "layout",
      label: "Layout",
      before: formatLayout(before.layout),
      after: layout
        ? formatLayout({
            x: layout.x ?? before.layout.x,
            y: layout.y ?? before.layout.y,
            w: layout.w ?? before.layout.w,
            h: layout.h ?? before.layout.h,
          })
        : undefined,
    },
  ];

  const fields: FieldDiff[] = specs.map((spec) => {
    const pending = spec.after === undefined;
    return {
      key: spec.key,
      label: spec.label,
      before: spec.before,
      after: pending ? spec.before : (spec.after as string),
      changed: !pending && spec.after !== spec.before,
      pending,
    };
  });

  const sql = diffSqlLines(before.query.sql, after.query?.sql ?? before.query.sql);
  const changedFields = fields.filter((f) => f.changed).length;

  return {
    fields,
    changedFields,
    sql,
    identical: changedFields === 0 && !sql.changed,
  };
}

/**
 * The panel to apply when the author accepts.
 *
 * The generated panel keeps the id of the panel it replaces: the model is free
 * to invent one, and letting it through would orphan the panel the author was
 * editing (the old id disappears from the spec, and anything pointing at it —
 * a `?panel=` link, the selection — points at nothing). Identity belongs to
 * the spec, not to the generation.
 */
export function acceptedPanel(before: Panel, generated: Panel): Panel {
  return { ...generated, id: before.id };
}
