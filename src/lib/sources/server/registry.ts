import { parseSourceKindName, type SourceKindName } from "@/lib/sources/registry";
import { prometheusServer } from "@/lib/sources/server/prometheus";
import {
  timescaledbManagement,
  timescaledbServer,
} from "@/lib/sources/server/timescaledb";
import type { ServerSourceKind } from "@/lib/sources/server/types";

export type { ServerSourceKind } from "@/lib/sources/server/types";

/**
 * The server-only half of every source kind: how a source of that kind is
 * checked, planned, executed, tested and described.
 *
 * Kept apart from `src/lib/sources/registry.ts`, which the browser bundle
 * reaches, the way `secrets/credentials.ts` is kept apart from
 * `secret-refs.ts`. The mapped type makes a kind without a server half a
 * compile error, and `ServerSourceKind` makes every one of them the same
 * shape, so a caller never asks which kind it holds.
 */
const SERVER_KINDS: { [K in SourceKindName]: ServerSourceKind } = {
  // Each entry's own `kind` is held to its key by test/source-kinds.test.ts.
  timescaledb: timescaledbServer,
  prometheus: prometheusServer,
};

/** The server half of a source's kind, or of a kind by name. */
export function serverKind(
  of: SourceKindName | { kind: SourceKindName },
): ServerSourceKind {
  return SERVER_KINDS[parseSourceKindName(typeof of === "string" ? of : of.kind)];
}

/**
 * Discovery and catalog refresh: SQL only until the Prometheus form lands
 * (#386). A route reaches them after `requireSqlSource`, which names any
 * other kind's refusal.
 */
export const sqlManagement = timescaledbManagement;

/** Discovery for a source about to be created; SQL only until #386. */
export const sqlDiscovery = timescaledbManagement.discover;

/** Close everything every kind holds open, for a graceful shutdown (#47). */
export async function closeAllSources(): Promise<void> {
  await Promise.all(Object.values(SERVER_KINDS).map((kind) => kind.closeAll()));
}
