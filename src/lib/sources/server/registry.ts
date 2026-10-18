import { parseSourceKindName, type SourceKindName } from "@/lib/sources/registry";
import { lokiServer } from "@/lib/sources/server/loki";
import { duckdbServer } from "@/lib/sources/server/duckdb";
import { prometheusServer } from "@/lib/sources/server/prometheus";
import {
  timescaledbManagement,
  timescaledbServer,
} from "@/lib/sources/server/timescaledb";
import { checkBaseUrl } from "@/lib/ai/guarded-fetch";
import { discoverLabels, discoverMetrics } from "@/lib/prometheus/catalog";
import { discoverLokiLabels, discoverLokiLabelValues } from "@/lib/loki/catalog";
import { sourceUrlAllowlist } from "@/lib/prometheus/client";
import type { ServerSourceKind } from "@/lib/sources/server/types";
import type { KindAvailability } from "@/lib/sources/types";
import { discoverDuckDbTables } from "@/lib/duckdb/catalog";
import { DuckDbPathError, listSourcePaths } from "@/lib/duckdb/path";
import { receiveUpload, UploadError, type UploadResult } from "@/lib/duckdb/uploads";

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
  loki: lokiServer,
  duckdb: duckdbServer,
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

/**
 * Discovery for a Prometheus source about to be created (#386): its URL
 * checked against `SOURCE_URL_ALLOWLIST`, then the metric menu, or the labels
 * of the metrics the author picked, read with the source's own credential.
 */
export function prometheusDiscovery(input: {
  workspaceId: string;
  url: string;
  auth: "none" | "basic" | "bearer";
  secretRef: string | null;
}) {
  const target = {
    id: "discovery",
    workspaceId: input.workspaceId,
    secretRef: input.secretRef,
    config: { url: input.url, auth: input.auth },
  };
  return {
    checkUrl: () => checkBaseUrl(input.url, sourceUrlAllowlist()),
    metrics: () => discoverMetrics(target),
    labels: (metrics: string[]) => discoverLabels(target, metrics),
  };
}

/**
 * Discovery for a Loki source about to be created (#563): its URL checked
 * against `SOURCE_URL_ALLOWLIST`, then the stream label names, or one label's
 * values, read with the source's own credential over the server's discovery
 * window, never a window the browser picks.
 */
export function lokiDiscovery(input: {
  workspaceId: string;
  url: string;
  auth: "none" | "basic" | "bearer";
  secretRef: string | null;
}) {
  const target = {
    id: "discovery",
    workspaceId: input.workspaceId,
    secretRef: input.secretRef,
    config: { url: input.url, auth: input.auth },
  };
  return {
    checkUrl: () => checkBaseUrl(input.url, sourceUrlAllowlist()),
    labels: () => discoverLokiLabels(target),
    values: (label: string) => discoverLokiLabelValues(target, label),
  };
}

/**
 * Discovery for a DuckDB source about to be created (#573): the tables and
 * columns under a path relative to `DUCKDB_SOURCES_DIR`, read on a freshly
 * opened, locked engine after the path guard, which holds a path under
 * `uploads/` to `workspaceId`'s own (#595). Errors name no path.
 */
export function duckdbDiscovery(path: string, workspaceId: string) {
  return { tables: () => discoverDuckDbTables(path, workspaceId) };
}

/**
 * What a DuckDB source may name (#573): the directories and `.duckdb` files
 * directly under `DUCKDB_SOURCES_DIR`, by name, or why there is nothing to
 * list. Never an absolute path, in either answer.
 */
export async function duckdbPathMenu(): Promise<
  | { ok: true; paths: { name: string; layout: "directory" | "database" }[] }
  | { ok: false; error: string }
> {
  try {
    return { ok: true, paths: await listSourcePaths() };
  } catch (err) {
    if (err instanceof DuckDbPathError) return { ok: false, error: err.message };
    throw err;
  }
}

/**
 * Take CSV and JSON files uploaded from the browser as a DuckDB source's directory
 * (#595), under `uploads/<workspaceId>/`, all or nothing. A refusal is an
 * answer, not a throw, with a message naming the variable or the person's
 * own file and never a server path.
 */
export async function duckdbUpload(input: {
  workspaceId: string;
  contentType: string | null;
  contentLength: number | null;
  body: ReadableStream<Uint8Array> | null;
}): Promise<({ ok: true } & UploadResult) | { ok: false; error: string; file?: string }> {
  try {
    return { ok: true, ...(await receiveUpload(input)) };
  } catch (err) {
    if (err instanceof UploadError) {
      return { ok: false, error: err.message, ...(err.file ? { file: err.file } : {}) };
    }
    if (err instanceof DuckDbPathError) return { ok: false, error: err.message };
    throw err;
  }
}

/**
 * Which kinds this server can hold a source of (#573), in registry order:
 * what the Add source dialog offers. A kind with no `availability` is always
 * available. A kind that takes uploads (#595) says whether it can now.
 */
export async function sourceKindAvailability(): Promise<KindAvailability[]> {
  return Promise.all(
    Object.values(SERVER_KINDS).map(async (server) => {
      const reason = (await server.availability?.()) ?? null;
      const base: KindAvailability =
        reason === null
          ? { kind: server.kind, available: true }
          : { kind: server.kind, available: false, reason };
      if (!server.uploads) return base;
      // A kind that is off takes no uploads either, for the same reason.
      const uploadsOff = reason ?? (await server.uploads.availability());
      return {
        ...base,
        uploads: {
          available: uploadsOff === null,
          ...(uploadsOff === null ? {} : { reason: uploadsOff }),
          ...server.uploads.limits(),
        },
      };
    }),
  );
}

/** Close everything every kind holds open, for a graceful shutdown (#47). */
export async function closeAllSources(): Promise<void> {
  await Promise.all(Object.values(SERVER_KINDS).map((kind) => kind.closeAll()));
}
