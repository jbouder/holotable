import type { z } from "zod";
import type { QueryLanguage } from "@/lib/ir";
import type { SourceRecord } from "@/lib/registry";
import type { SourceListing } from "@/lib/source-listing";
import type { SourceCatalog } from "@/lib/sources/catalog";

/**
 * The query language a panel against a source carries is a property of the
 * source's kind, never of the panel's: a time series and a table can be drawn
 * from either language, but a source can only answer one.
 */
export type { QueryLanguage };

/**
 * What a source kind declares about itself, in plain data and functions, for
 * code that may run in the browser. The server-only half (connecting,
 * discovering, executing) is {@link ServerSourceKind} in
 * `src/lib/sources/server/`.
 *
 * Every projection is an explicit allowlist of fields. A kind never spreads
 * its config into one, so a field added to a config later reaches a browser
 * only when someone names it here.
 */
export interface SourceKind<Name extends string, Config extends z.ZodType> {
  /** The stored value of `sources.kind`. Never renamed. */
  kind: Name;
  /** How the kind is named to a person. */
  label: string;
  language: QueryLanguage;
  /** The strict config schema, catalog and row filter included. */
  config: Config;
  /** How to reach the source, without the catalog. */
  connection(cfg: z.infer<Config>): unknown;
  /** What the editor may see of the catalog: no connection detail, no hidden column. */
  catalog(cfg: z.infer<Config>): SourceCatalog;
  /** What someone who may use but not manage the source may see of it. */
  listing(source: SourceRecord): SourceListing;
}
