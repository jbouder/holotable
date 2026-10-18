import {
  type BaseUrlAllowlist,
  hostOf,
  parseBaseUrlAllowlist,
  withEndpointHosts,
} from "@/lib/ai/base-url";
import { aiConfigProblem } from "@/lib/ai/configured";
import { guardedFetch } from "@/lib/ai/guarded-fetch";
import { ModelSettings } from "@/lib/ai/providers/registry";
import { listOpenAiStyle } from "@/lib/ai/providers/server/list";
import {
  type Environment,
  localModelDetection,
  parseLocalModelEndpoints,
} from "@/lib/config";
import { log } from "@/lib/log";

/**
 * A model on the person's own machine (#607): Ollama, LM Studio, anything
 * that answers the OpenAI-style `GET /models` at one of the base URLs in
 * `LOCAL_MODEL_ENDPOINTS`, found with no key and no variable to learn.
 *
 * Detection is server-side only. It runs when `LOCAL_MODEL_DETECT` resolves to
 * on (by default, in local mode), at boot and on a Re-scan from the Models
 * page; nothing a browser sends names an endpoint. Each endpoint is asked
 * through the base URL guard's fetch (`guarded-fetch.ts`) under the model
 * list's byte cap and a short timeout, with the endpoints' hosts allowlisted
 * as if they were in `AI_BASE_URL_ALLOWLIST`: operator configuration, not a
 * typed URL. A base URL typed in the app is held to `AI_BASE_URL_ALLOWLIST`
 * alone, as before.
 *
 * Each model found becomes a server model, as an `AI_MODELS_FILE` entry
 * would: `openai-compatible`, that base URL, the chat API, no credentials,
 * named `local:<host>:<port>/<model>`, a prefix neither the file's names nor
 * `env:` ids can take. The last scan is kept for the process, on
 * `globalThis` so every bundle reads the same one.
 */

/** How long one endpoint has to answer its model list, in milliseconds. */
export const LOCAL_PROBE_TIMEOUT_MS = 3_000;

/** The prefix of a detected model's id and name. */
export const LOCAL_MODEL_PREFIX = "local:";

/** At most this many models are taken from one endpoint. */
export const MAX_DETECTED_PER_ENDPOINT = 50;

/** A model id as a detected id may carry it: what Ollama and LM Studio name models with. */
const MODEL_PART = /^[A-Za-z0-9._:/@+-]{1,120}$/;

/** A detected model's id: `local:<host>:<port>/<model>`. Held by `ModelId` too. */
export const DETECTED_MODEL_ID =
  /^local:[a-z0-9.-]{1,100}:\d{1,5}\/[A-Za-z0-9._:/@+-]{1,120}$/;

/** One endpoint's answer at the last scan: its host, never a reply body. */
export interface ScannedEndpoint {
  /** `host:port`, the label in each of its models' names. */
  label: string;
  host: string;
  baseUrl: string;
  ok: boolean;
  /** The model ids it listed, sorted; empty when it did not answer. */
  models: string[];
}

export interface LocalScan {
  /** When the scan finished, ISO 8601. */
  scannedAt: string;
  endpoints: ScannedEndpoint[];
}

/** A model found on this machine, ready to list and build as a server model. */
export interface DetectedModel {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
}

/**
 * An endpoint's label: its host and port, the host reduced to the characters
 * a model id may carry (an IPv6 literal's colons become dashes).
 */
export function endpointLabel(baseUrl: string): string {
  const url = new URL(baseUrl);
  const host = hostOf(url).replace(/[^a-z0-9.-]/g, "-");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${host}:${port}`;
}

/** A detected model's id, or null when the model's name cannot be one. */
export function detectedModelId(label: string, model: string): string | null {
  if (!MODEL_PART.test(model)) return null;
  const id = `${LOCAL_MODEL_PREFIX}${label}/${model}`;
  return DETECTED_MODEL_ID.test(id) ? id : null;
}

/** The endpoints detection probes, or none when it is off. */
export function detectionEndpoints(env: Environment): string[] {
  if (!localModelDetection(env)) return [];
  return parseLocalModelEndpoints(env.LOCAL_MODEL_ENDPOINTS).endpoints;
}

/**
 * What the probe and the models it finds may reach: `AI_BASE_URL_ALLOWLIST`
 * with every endpoint's host added, while detection is on; null when it is
 * off, when nothing is probed and nothing is added.
 */
export function detectionAllowlist(env: Environment): BaseUrlAllowlist | null {
  if (!localModelDetection(env)) return null;
  return withEndpointHosts(
    parseBaseUrlAllowlist(env.AI_BASE_URL_ALLOWLIST),
    detectionEndpoints(env),
  );
}

const CACHE_KEY = Symbol.for("holotable.localModelScan");
type Cache = {
  [CACHE_KEY]?: { scan: LocalScan | null; running: Promise<LocalScan | null> | null };
};

function state() {
  const cache = globalThis as Cache;
  cache[CACHE_KEY] ??= { scan: null, running: null };
  return cache[CACHE_KEY];
}

/** The last scan, or null when none has finished (or detection is off). */
export function lastLocalScan(): LocalScan | null {
  return state().scan;
}

/** Forget the last scan, for tests. */
export function forgetLocalScan(): void {
  const s = state();
  s.scan = null;
  s.running = null;
}

export interface ScanDeps {
  env: Environment;
  /** The fetch for one endpoint; the guarded fetch by default. */
  fetchFor?: (baseUrl: string, allowlist: BaseUrlAllowlist) => typeof globalThis.fetch;
  timeoutMs?: number;
  now?: () => Date;
}

/** A fetch whose every request is aborted by `signal`, the reply's body included. */
function withSignal(
  fetch: typeof globalThis.fetch,
  signal: AbortSignal,
): typeof globalThis.fetch {
  const signaled = (input: string | URL | Request, init?: RequestInit) =>
    fetch(input, { ...init, signal });
  return signaled as typeof globalThis.fetch;
}

/** The whole probe of one endpoint, request and reply, given up after `ms`. */
async function timed<T>(
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("timed out"));
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function probe(
  baseUrl: string,
  allowlist: BaseUrlAllowlist,
  deps: ScanDeps,
): Promise<ScannedEndpoint> {
  const label = endpointLabel(baseUrl);
  const host = label;
  const fetchFor = deps.fetchFor ?? guardedFetch;
  try {
    const listed = await timed(deps.timeoutMs ?? LOCAL_PROBE_TIMEOUT_MS, (signal) =>
      listOpenAiStyle(
        withSignal(fetchFor(baseUrl, allowlist), signal),
        baseUrl,
        undefined,
      ),
    );
    const models = listed
      .map((m) => m.id)
      .filter((id) => detectedModelId(label, id) !== null)
      .slice(0, MAX_DETECTED_PER_ENDPOINT);
    return { label, host, baseUrl, ok: true, models };
  } catch {
    // Dead, slow, refused by the guard, not JSON, over the cap: skipped and
    // counted. The error is not logged; it may quote the reply.
    return { label, host, baseUrl, ok: false, models: [] };
  }
}

async function runScan(deps: ScanDeps): Promise<LocalScan | null> {
  const allowlist = detectionAllowlist(deps.env);
  if (!allowlist) return null;
  const endpoints = await Promise.all(
    detectionEndpoints(deps.env).map((baseUrl) => probe(baseUrl, allowlist, deps)),
  );
  const scan: LocalScan = {
    scannedAt: (deps.now?.() ?? new Date()).toISOString(),
    endpoints,
  };
  const answered = endpoints.filter((e) => e.ok);
  const chosen = detectedDefault(scan, deps.env);
  log.info("models.detected", {
    endpoints: endpoints.length,
    answered: answered.length,
    skipped: endpoints.length - answered.length,
    models: answered.reduce((n, e) => n + e.models.length, 0),
    answeredHosts: answered.map((e) => e.host),
    skippedHosts: endpoints.filter((e) => !e.ok).map((e) => e.host),
    ...(chosen ? { default: chosen } : {}),
  });
  return scan;
}

/**
 * Probe every endpoint and keep what answered. Null, probing nothing, when
 * detection is off. A scan asked for while one runs joins it.
 */
export function scanLocalModels(
  deps: ScanDeps = { env: process.env },
): Promise<LocalScan | null> {
  const s = state();
  if (s.running) return s.running;
  const running = runScan(deps)
    .then((scan) => {
      if (scan) s.scan = scan;
      return scan;
    })
    .finally(() => {
      s.running = null;
    });
  s.running = running;
  return running;
}

/** Every model the scan found, in endpoint order. */
export function detectedModels(
  scan: LocalScan | null = lastLocalScan(),
): DetectedModel[] {
  if (!scan) return [];
  return scan.endpoints.flatMap((endpoint) =>
    endpoint.models.flatMap((model) => {
      const id = detectedModelId(endpoint.label, model);
      return id ? [{ id, label: endpoint.label, baseUrl: endpoint.baseUrl, model }] : [];
    }),
  );
}

/**
 * The detected model that is the server's default, or null: only when the
 * server has none of its own (`AI_MODEL` and `AI_MODELS_FILE` unset, and not
 * the stub) and exactly one endpoint answered with a model, whose first model
 * it is. With more than one, which to use is the person's pick.
 */
export function detectedDefault(scan: LocalScan | null, env: Environment): string | null {
  if (!scan || env.AI_MODEL || env.AI_MODELS_FILE || aiConfigProblem(env) === null) {
    return null;
  }
  const answered = scan.endpoints.filter((e) => e.ok && e.models.length > 0);
  if (answered.length !== 1) return null;
  return detectedModelId(answered[0].label, answered[0].models[0]);
}

/** A detected model's settings, as an `AI_MODELS_FILE` entry would declare it. */
export function detectedSettings(model: DetectedModel): ModelSettings | null {
  const parsed = ModelSettings.safeParse({
    provider: "openai-compatible",
    baseUrl: model.baseUrl,
    model: model.model,
    api: "chat",
  });
  return parsed.success ? parsed.data : null;
}
