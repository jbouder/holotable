import { z } from "zod";
import { timescaledb } from "@/lib/sources/kinds/timescaledb";

/**
 * The source kinds (#382): what a source may be, as `src/lib/panels/registry.ts`
 * is what a panel may be.
 *
 * A kind is registered by importing its module and listing it here; nothing
 * looks a kind up by a string it was not given by a stored row or a parsed
 * body. Code that needs to behave differently per kind asks the kind
 * (`sourceKind(record)`, or `serverKind(record)` on the server) and uses what
 * comes back. It never compares `source.kind` itself: `test/source-kinds.test.ts`
 * fails on a `kind` comparison or a `case "timescaledb"` outside
 * `src/lib/sources/`, and on an import of `src/lib/timescaledb/` that does not
 * go through the server half.
 */
export const SOURCE_KINDS = { timescaledb } as const;

export type SourceKindName = keyof typeof SOURCE_KINDS;

export const SOURCE_KIND_NAMES = Object.keys(SOURCE_KINDS) as SourceKindName[];

/**
 * A source's config: the union of every kind's config on its `kind` field.
 *
 * The TimescaleDB branch defaults its discriminator, so a config stored before
 * the union existed (no `kind`) still parses as TimescaleDB. No later kind may
 * default its own: there can only be one reading of a config that does not
 * say what it is, and it is the one every such config was written as.
 */
export const SourceConfig = z.discriminatedUnion("kind", [timescaledb.config]);
export type SourceConfig = z.infer<typeof SourceConfig>;

export function isSourceKindName(value: unknown): value is SourceKindName {
  return typeof value === "string" && Object.hasOwn(SOURCE_KINDS, value);
}

/**
 * A stored `sources.kind`, checked. An unknown kind fails to load with a
 * message naming it, as an unknown `specVersion` does: a row this code cannot
 * describe is refused, never read as the nearest kind it resembles.
 */
export function parseSourceKindName(value: string): SourceKindName {
  if (!isSourceKindName(value)) {
    throw new Error(
      `unknown source kind "${value}" (this server knows ${SOURCE_KIND_NAMES.join(", ")})`,
    );
  }
  return value;
}

/**
 * A stored row's `kind` column and `config` JSONB, read together.
 *
 * A config written before the union has no `kind` and is read as the column
 * says; one that has a `kind` must agree with the column. Either failure
 * throws rather than guessing, so a row that has been edited by hand into
 * an inconsistent state is refused where it is loaded.
 */
export function parseStoredSource(
  column: string,
  config: unknown,
): { kind: SourceKindName; config: SourceConfig } {
  const kind = parseSourceKindName(column);
  const raw =
    config && typeof config === "object" ? (config as Record<string, unknown>) : {};
  if (raw.kind !== undefined && raw.kind !== kind) {
    throw new Error(
      `source config says kind "${String(raw.kind)}" but the row says "${kind}"`,
    );
  }
  return { kind, config: SourceConfig.parse({ ...raw, kind }) };
}

/** The kind of a source, a config, or a kind name. */
export function sourceKind(of: SourceKindName | { kind: SourceKindName }) {
  return SOURCE_KINDS[parseSourceKindName(typeof of === "string" ? of : of.kind)];
}

/** Whether two sources, configs or bodies are of the one kind. */
export function sameKind(
  a: { kind: SourceKindName },
  b: { kind: SourceKindName },
): boolean {
  return a.kind === b.kind;
}
