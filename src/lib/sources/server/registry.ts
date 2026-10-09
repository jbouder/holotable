import { type SourceKindName, parseSourceKindName } from "@/lib/sources/registry";
import { timescaledbServer } from "@/lib/sources/server/timescaledb";

/**
 * The server-only half of every source kind: how a source of that kind is
 * discovered, refreshed, tested, validated against, planned and executed.
 *
 * Kept apart from `src/lib/sources/registry.ts`, which the browser bundle
 * reaches, the way `secrets/credentials.ts` is kept apart from
 * `secret-refs.ts`. The mapped type makes a kind without a server half a
 * compile error.
 */
const SERVER_KINDS = {
  timescaledb: timescaledbServer,
} as const satisfies { [K in SourceKindName]: { kind: K } };

export type ServerSourceKind = (typeof SERVER_KINDS)[SourceKindName];

/** The server half of a source's kind, or of a kind by name. */
export function serverKind(
  of: SourceKindName | { kind: SourceKindName },
): ServerSourceKind {
  return SERVER_KINDS[parseSourceKindName(typeof of === "string" ? of : of.kind)];
}

/** Close everything every kind holds open, for a graceful shutdown (#47). */
export async function closeAllSources(): Promise<void> {
  await Promise.all(Object.values(SERVER_KINDS).map((kind) => kind.closeAll()));
}
