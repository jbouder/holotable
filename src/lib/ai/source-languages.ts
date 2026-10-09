import type { z } from "zod";
import type { QueryLanguage } from "@/lib/ir";

/**
 * A generation schema held to each source's language (#387): a panel or a
 * variable that queries a source in the other language fails the schema, so
 * the one repair (#21) tells the model which field to write instead. The
 * guard would refuse it on save anyway; this is what turns that refusal into
 * a second chance rather than a dead end.
 */

interface QueryLike {
  sourceId?: unknown;
  sql?: unknown;
  promql?: unknown;
  label?: unknown;
}

function languageOf(query: QueryLike): QueryLanguage | null {
  if (typeof query.sql === "string") return "sql";
  if (typeof query.promql === "string" || typeof query.label === "string")
    return "promql";
  return null;
}

const FIELD: Record<QueryLanguage, string> = { sql: "query.sql", promql: "query.promql" };
const NAME: Record<QueryLanguage, string> = { sql: "SQL", promql: "PromQL" };

export function wrongLanguages(
  value: unknown,
  languages: Readonly<Record<string, QueryLanguage>>,
): { path: (string | number)[]; message: string }[] {
  const found: { path: (string | number)[]; message: string }[] = [];
  const check = (
    query: QueryLike | undefined,
    path: (string | number)[],
    what: string,
  ) => {
    if (!query || typeof query.sourceId !== "string") return;
    const answers = languages[query.sourceId];
    const written = languageOf(query);
    if (!answers || !written || answers === written) return;
    found.push({
      path,
      message: `${what} queries source "${query.sourceId}", which answers ${NAME[answers]}; write "${FIELD[answers]}" instead of "${FIELD[written]}"`,
    });
  };
  if (typeof value !== "object" || value === null) return found;
  const v = value as {
    panels?: { id?: unknown; query?: QueryLike }[];
    variables?: { name?: unknown; query?: QueryLike }[];
    id?: unknown;
    query?: QueryLike;
  };
  if (Array.isArray(v.panels)) {
    for (const [i, p] of v.panels.entries()) {
      check(p?.query, ["panels", i, "query"], `panel "${String(p?.id)}"`);
    }
    for (const [i, variable] of (v.variables ?? []).entries()) {
      check(
        variable?.query,
        ["variables", i, "query"],
        `variable "${String(variable?.name)}"`,
      );
    }
  } else {
    check(v.query, ["query"], `panel "${String(v.id)}"`);
  }
  return found;
}

export function withSourceLanguages<S extends z.ZodType>(
  schema: S,
  languages: Readonly<Record<string, QueryLanguage>>,
): S {
  return schema.superRefine((value, ctx) => {
    for (const issue of wrongLanguages(value, languages)) {
      ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
    }
  }) as unknown as S;
}
