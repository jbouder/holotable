import { readFileSync } from "node:fs";
import { aiConfigProblem } from "@/lib/ai/configured";
import { parseBaseUrlAllowlist } from "@/lib/ai/base-url";
import { environmentResolution, type ResolvedModel } from "@/lib/ai/model-resolution";
import { configuredModel } from "@/lib/ai/provider";
import { kindOf } from "@/lib/ai/providers/registry";
import {
  LEGACY_MODEL_NAME,
  parseServerModels,
  type ServerModelEntry,
} from "@/lib/ai/server-models";
import type { Environment } from "@/lib/config";
import { log } from "@/lib/log";

/**
 * The server's models at runtime (#440): the entries of `AI_MODELS_FILE`,
 * then the legacy `AI_PROVIDER`/`AI_MODEL` variables as one implicit entry
 * named `default`.
 *
 * The file is read once per path and kept: a change takes a restart, like
 * every variable. Boot refuses a file that does not parse
 * (`src/lib/startup.ts`), so the runtime reading it badly is a file changed
 * under a running server; it then lists no file models and says so once in
 * the log.
 */

/** One server model, as the catalog lists and builds it. */
export interface ServerModel {
  id: string;
  name: string;
  provider: string;
  model: string;
  /** The variables its credentials come from, by field; never their values. */
  credentialVars: Record<string, string>;
  /** Why it cannot be called, or null. */
  unavailable: string | null;
  resolve(): ResolvedModel;
}

const files = new Map<string, ServerModelEntry[]>();

/** The parsed file, read once per path. */
function fileEntries(path: string): ServerModelEntry[] {
  const cached = files.get(path);
  if (cached) return cached;
  let entries: ServerModelEntry[] = [];
  try {
    const parsed = parseServerModels(readFileSync(path, "utf8"));
    if (parsed.problems.length > 0) {
      log.error("ai.server_models.invalid", { path, problems: parsed.problems });
    } else {
      entries = parsed.entries;
    }
  } catch (err) {
    log.error("ai.server_models.unreadable", {
      path,
      code: (err as { code?: string }).code ?? "error",
    });
  }
  files.set(path, entries);
  return entries;
}

/** Forget what was read, for tests that write a new file at the same path. */
export function forgetServerModelFiles(): void {
  files.clear();
}

/**
 * Whether the legacy variables name a model. Without `AI_MODELS_FILE` the
 * implicit entry is always listed, configured or not, exactly as before.
 */
export function legacyConfigured(env: Environment): boolean {
  return Boolean(env.AI_PROVIDER || env.AI_MODEL);
}

/** The operator's base URLs are not held to the address rules; the allowlist is unused. */
const OPERATOR = parseBaseUrlAllowlist("");

function fromEntry(entry: ServerModelEntry, env: Environment): ServerModel {
  const credentials: Record<string, string> = {};
  const unset: string[] = [];
  for (const [field, variable] of Object.entries(entry.credentials)) {
    const value = env[variable];
    if (value) credentials[field] = value;
    else unset.push(variable);
  }
  const stubRefused =
    kindOf(entry.settings).developmentOnly === true &&
    env.NODE_ENV === "production" &&
    env.AI_STUB_IN_PRODUCTION !== "true";
  const unavailable =
    unset.length > 0
      ? `${unset.join(" and ")} ${unset.length > 1 ? "are" : "is"} not set on the server, so the server model "${entry.name}" cannot be called.`
      : stubRefused
        ? `The server model "${entry.name}" is the stub, which is refused in production.`
        : null;
  return {
    id: entry.id,
    name: entry.name,
    provider: entry.settings.provider,
    model: entry.settings.model,
    credentialVars: entry.credentials,
    unavailable,
    resolve: () =>
      unavailable
        ? { ok: false, id: entry.id, source: "environment", problem: unavailable }
        : {
            ok: true,
            id: entry.id,
            source: "environment",
            modelId: entry.settings.model,
            model: configuredModel(entry.settings, credentials, OPERATOR, {
              operator: true,
            }),
          },
  };
}

/** The legacy variables as the server model `default`, answering exactly as before #440. */
function legacyModel(env: Environment): ServerModel {
  const id = `env:${LEGACY_MODEL_NAME}`;
  const provider = env.AI_PROVIDER || "openai-compatible";
  const resolved = environmentResolution(id, env);
  const keyVar =
    provider === "gateway"
      ? "AI_GATEWAY_API_KEY"
      : provider === "openai-compatible"
        ? "OPENAI_API_KEY"
        : null;
  return {
    id,
    name: LEGACY_MODEL_NAME,
    provider,
    model: provider === "stub" ? "stub" : (env.AI_MODEL ?? ""),
    credentialVars: keyVar ? { apiKey: keyVar } : {},
    unavailable: resolved.ok ? null : resolved.problem,
    resolve: () => environmentResolution(id, env),
  };
}

/**
 * Every server model, the default first. The default is the file's
 * `"default": true` entry; else the legacy variables' model, when they name
 * one; else the file's first entry.
 */
export function serverModelList(env: Environment = process.env): ServerModel[] {
  const path = env.AI_MODELS_FILE;
  const fromFile = path ? fileEntries(path) : [];
  const legacy =
    !path || legacyConfigured(env)
      ? fromFile.some((e) => e.name === LEGACY_MODEL_NAME)
        ? null
        : legacyModel(env)
      : null;
  const models = [...fromFile.map((e) => fromEntry(e, env)), ...(legacy ? [legacy] : [])];
  const declared = fromFile.find((e) => e.default)?.id;
  const defaultId = declared ?? legacy?.id ?? models[0]?.id;
  return [
    ...models.filter((m) => m.id === defaultId),
    ...models.filter((m) => m.id !== defaultId),
  ];
}

/** The server's default model, or null when it has none. */
export function serverDefault(env: Environment = process.env): ServerModel | null {
  return serverModelList(env)[0] ?? null;
}

/**
 * Why the server's default cannot be called, as readiness reports it, or
 * null. Configuration only: nothing is called.
 */
export function serverModelProblem(env: Environment = process.env): string | null {
  if (!env.AI_MODELS_FILE) {
    const problem = aiConfigProblem(env);
    if (!problem) return null;
    return problem === "AI_PROVIDER"
      ? "AI_PROVIDER is not recognized"
      : `${problem} is not set`;
  }
  const chosen = serverDefault(env);
  if (!chosen) return "AI_MODELS_FILE lists no models";
  return chosen.unavailable;
}

/**
 * A server model by its name, for `npm run eval -- --live --model <name>`
 * (#443); without a name, the server's default. An unknown name says which
 * names are on offer.
 */
export function serverModelByName(
  name: string | undefined,
  env: Environment = process.env,
): { ok: true; model: ServerModel } | { ok: false; message: string } {
  const all = serverModelList(env);
  if (!name) {
    return all[0]
      ? { ok: true, model: all[0] }
      : { ok: false, message: "No server model is configured." };
  }
  const found = all.find((m) => m.name === name);
  if (found) return { ok: true, model: found };
  return {
    ok: false,
    message: `No server model is named "${name}". On offer: ${all.map((m) => m.name).join(", ") || "none"}.`,
  };
}
