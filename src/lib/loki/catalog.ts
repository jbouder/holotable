import { createHash } from "node:crypto";
import { config } from "@/lib/config";
import {
  type LokiTarget,
  LokiUnavailableError,
  lokiPing,
  lokiRequest,
  lokiTime,
} from "@/lib/loki/client";
import { durationMs } from "@/lib/promql/parse";
import type { SourceTestResult, TestLabel } from "@/lib/source-test";
import {
  type LokiConfig,
  LokiConfig as LokiConfigSchema,
  LokiLabel,
  LokiLabelValue,
  MAX_LABEL_VALUES,
  MAX_LABELS,
} from "@/lib/sources/kinds/loki";

/**
 * A Loki source's catalog, from its endpoint (#562): the stream labels it
 * knows, the values each carries, and the connection test. Everything here
 * runs with the source's own credential through the same guarded fetch as a
 * query, so discovery can show no more than execution could read. Every
 * request is bounded to the discovery window (`PROMETHEUS_DISCOVERY_WINDOW`,
 * the one discovery window for both HTTP kinds), never all time.
 */

function windowMs(): number {
  return durationMs(config.prometheusDiscoveryWindow) ?? 3_600_000;
}

function windowParams(extra: Record<string, string> = {}): URLSearchParams {
  const end = new Date();
  const start = new Date(end.getTime() - windowMs());
  return new URLSearchParams({ start: lokiTime(start), end: lokiTime(end), ...extra });
}

const timeouts = () => ({ timeoutMs: config.queryTimeoutSeconds * 1000 });

/** Run `work` over `items`, a few at a time, keeping their order. */
async function eachBounded<T, R>(
  items: T[],
  work: (item: T) => Promise<R>,
  limit = 8,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** The stream label names the endpoint holds over the discovery window. */
export async function discoverLokiLabels(target: LokiTarget): Promise<string[]> {
  const data = await lokiRequest(target, "labels", windowParams(), timeouts());
  return (Array.isArray(data) ? data : [])
    .filter((l): l is string => typeof l === "string")
    .filter((l) => LokiLabel.shape.name.safeParse(l).success)
    .sort()
    .slice(0, MAX_LABELS);
}

/** One label's values over the discovery window, as hints: sorted and capped. */
export async function discoverLokiLabelValues(
  target: LokiTarget,
  label: string,
): Promise<string[]> {
  const data = await lokiRequest(
    target,
    `label/${encodeURIComponent(label)}/values`,
    windowParams(),
    timeouts(),
  );
  return [...new Set(Array.isArray(data) ? data : [])]
    .filter(
      (v): v is string => typeof v === "string" && LokiLabelValue.safeParse(v).success,
    )
    .sort()
    .slice(0, MAX_LABEL_VALUES);
}

export interface LokiCatalogRefresh {
  config: LokiConfig;
  /** Allowlisted labels with no values in the discovery window. */
  missingTables: string[];
}

/**
 * The allowlist re-read from the endpoint. Like the other kinds' refresh,
 * the allowlist is the author's: no label is added or dropped. A label with
 * streams gets its values as they are now; one without keeps its last known
 * values and is reported missing.
 */
export async function refreshLokiCatalog(
  target: LokiTarget,
  current: LokiConfig,
): Promise<LokiCatalogRefresh> {
  const found = await eachBounded(current.labels, (l) =>
    discoverLokiLabelValues(target, l.name),
  );
  const missingTables: string[] = [];
  const labels = current.labels.map((label, i) => {
    if (found[i].length === 0) {
      missingTables.push(label.name);
      return label;
    }
    return { ...label, values: found[i] };
  });
  return { config: LokiConfigSchema.parse({ ...current, labels }), missingTables };
}

/** The digest an apply must send back: the same catalog, or a conflict. */
export function lokiRefreshDigest(refresh: LokiCatalogRefresh): string {
  return createHash("sha256")
    .update(
      JSON.stringify({ labels: refresh.config.labels, missing: refresh.missingTables }),
    )
    .digest("hex");
}

async function labelReachability(
  target: LokiTarget,
  labels: string[],
): Promise<TestLabel[]> {
  const window = config.prometheusDiscoveryWindow;
  return eachBounded(labels, async (label) => {
    try {
      const values = await discoverLokiLabelValues(target, label);
      return values.length > 0
        ? { label, reachable: true }
        : { label, reachable: false, error: `no streams in the last ${window}` };
    } catch (err) {
      return {
        label,
        reachable: false,
        error:
          err instanceof LokiUnavailableError && err.status !== undefined
            ? `the endpoint answered ${err.status}`
            : "the endpoint could not be asked",
      };
    }
  });
}

/**
 * Connectivity, the build, the auth and every allowlisted label's streams.
 * Nothing here writes, and Loki has no write surface a query credential
 * reaches through the read API, so there is none to report.
 */
export async function testLoki(
  target: LokiTarget,
  cfg: LokiConfig,
): Promise<SourceTestResult> {
  const t0 = performance.now();
  const ready = await lokiPing(target, "/ready", timeouts()).catch(() => null);
  const connectMs = performance.now() - t0;

  const t1 = performance.now();
  try {
    await lokiRequest(target, "labels", windowParams(), timeouts());
  } catch (err) {
    const status = err instanceof LokiUnavailableError ? err.status : undefined;
    const rejected = status === 401 || status === 403;
    return {
      ok: false,
      message: rejected
        ? `The endpoint refused the ${cfg.auth === "none" ? "unauthenticated request" : "credential"} (${status}).`
        : status !== undefined
          ? `The endpoint answered ${status}.`
          : "The endpoint could not be reached.",
      ...(rejected ? { auth: { mode: cfg.auth, accepted: false } } : {}),
    };
  }
  const queryMs = performance.now() - t1;

  const build = (await lokiRequest(
    target,
    "status/buildinfo",
    new URLSearchParams(),
    timeouts(),
  ).catch(() => null)) as Record<string, unknown> | null;
  const version = typeof build?.version === "string" ? build.version : null;

  const labels = await labelReachability(
    target,
    cfg.labels.map((l) => l.name),
  );
  return {
    ok: true,
    message:
      ready?.ok === false
        ? "Connected, though /ready did not answer ready."
        : "Connected.",
    latency: { connectMs, queryMs },
    endpoint: { product: version !== null ? "Loki" : "a Loki-compatible API", version },
    auth: { mode: cfg.auth, accepted: true },
    labels,
  };
}
