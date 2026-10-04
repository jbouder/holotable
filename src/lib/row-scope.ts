import { HttpError } from "@/lib/auth/authorize";
import { claimValue, type Identity, SUBJECT_CLAIM } from "@/lib/auth/claims";
import { config } from "@/lib/config";
import type { SourceConfig, SourceRecord } from "@/lib/registry";
import {
  bindRowFilter,
  RowFilterDenied,
  RowFilterError,
  type RowFilterBinding,
  rowFilterProblem,
} from "@/lib/sql/row-filter";

/**
 * Row-level filters (#31) at the edges: from a viewer to the value a source
 * filters on, and from the rewrite's two failures to what a caller answers.
 * The rewrite itself, and why it narrows tables rather than the output, is
 * `src/lib/sql/row-filter.ts`.
 */

/**
 * The claim values a dashboard's pollers run with: one entry per claim its
 * row-filtered sources name, and nothing else. Two viewers with the same
 * scope see the same rows, so they share a poller; two with different scopes
 * never do. A claim the viewer lacks is simply absent, and every panel on a
 * source that needs it is refused.
 */
export type RowScope = Readonly<Record<string, string>>;

/** The row filter for one viewer on one source, as an HTTP refusal if it cannot be bound. */
export function rowFilterFor(
  source: SourceRecord,
  identity: Identity,
): RowFilterBinding | null {
  try {
    return bindRowFilter(source.config, (claim) => claimValue(identity, claim));
  } catch (err) {
    throw rowFilterHttpError(err);
  }
}

/** The scope a viewer's stream of a dashboard over `sources` runs with. */
export function rowScopeFor(
  identity: Identity,
  sources: readonly SourceRecord[],
): RowScope {
  const scope: Record<string, string> = {};
  for (const source of sources) {
    const claim = source.config.rowFilter?.claim;
    if (!claim) continue;
    const value = claimValue(identity, claim);
    if (value !== undefined && value !== "") scope[claim] = value;
  }
  return scope;
}

/** The row filter for a poller's scope on one source. Throws `RowFilterDenied`. */
export function rowFilterInScope(
  source: SourceRecord,
  scope: RowScope,
): RowFilterBinding | null {
  return bindRowFilter(source.config, (claim) =>
    Object.hasOwn(scope, claim) ? scope[claim] : undefined,
  );
}

/**
 * What a route answers for a row-filter failure: a viewer without the claim
 * is a 403, and a statement the rewrite cannot filter is the author's to fix,
 * a 400 tagged `statement`. Anything else is returned unchanged.
 */
export function rowFilterHttpError(err: unknown): unknown {
  if (err instanceof RowFilterDenied) {
    return new HttpError(
      403,
      "you have no access to this source's rows",
      {},
      "authorization",
    );
  }
  if (err instanceof RowFilterError) {
    return new HttpError(400, err.message, {}, "statement");
  }
  return err;
}

/**
 * Refuse to save a source whose row filter could never be satisfied: a claim
 * no session carries, or a column some table lacks. Either would leave every
 * query on the source refused, which is safe but is better said up front.
 */
export function assertRowFilterSavable(cfg: SourceConfig): void {
  const filter = cfg.rowFilter;
  if (!filter) return;
  if (filter.claim !== SUBJECT_CLAIM && !config.rowFilterClaims.includes(filter.claim)) {
    throw new HttpError(
      400,
      `row filter claim "${filter.claim}" is not carried into sessions; add it to ROW_FILTER_CLAIMS or use "sub"`,
      {},
      "validation",
    );
  }
  const problem = rowFilterProblem(cfg);
  if (problem) throw new HttpError(400, problem, {}, "validation");
}
