import { z } from "zod";
import type { ConfigProblem } from "@/lib/config";
import {
  credentialFields,
  kindOf,
  type ModelSettings,
  PROVIDER_KIND_NAMES,
  providerKind,
} from "@/lib/ai/providers/registry";

/**
 * Server-managed models (#440): the models an operator declares in the
 * JSON file `AI_MODELS_FILE` names, read once at boot.
 *
 * ```json
 * { "models": [
 *   { "name": "claude", "provider": "anthropic", "model": "claude-sonnet-5-5",
 *     "credentials": { "apiKey": "ANTHROPIC_API_KEY" }, "default": true },
 *   { "name": "local", "provider": "openai-compatible", "model": "llama3",
 *     "baseUrl": "http://ollama.internal:11434/v1", "api": "chat" }
 * ] }
 * ```
 *
 * An entry is a provider kind's settings plus `name`, `default` and
 * `credentials`, which maps each secret field to the **name** of an
 * environment variable, never a value. The file can live in a ConfigMap and
 * be read by anyone who can read the deployment; the values stay in
 * Secrets. This module is the parser, shared by the boot check
 * (`src/lib/startup.ts`) and the runtime (`server-models-file.ts`); it reads
 * no file and no variable itself.
 */

/** A server model's name: it appears in `env:<name>` ids and `eval --model`. */
export const SERVER_MODEL_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** An environment variable's name, spelled as `SOURCE_SECRET_REFS` spells them. */
export const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;

/** The name the legacy `AI_PROVIDER`/`AI_MODEL` variables are listed under. */
export const LEGACY_MODEL_NAME = "default";

/** At most this many entries: the file is a list a person maintains, not a catalog. */
export const MAX_SERVER_MODELS = 50;

/** One parsed entry. `credentials` maps each secret field to a variable name. */
export interface ServerModelEntry {
  name: string;
  id: string;
  settings: ModelSettings;
  credentials: Record<string, string>;
  default: boolean;
}

const FileShape = z
  .object({ models: z.array(z.record(z.string(), z.unknown())).max(MAX_SERVER_MODELS) })
  .strict();

/**
 * Parse the file's text. Every problem names the entry (by its `name`, or
 * its position when it has none) and the field, and never a value: an
 * operator who put a key where a variable name belongs must not find the
 * key in a log line.
 */
export function parseServerModels(text: string): {
  entries: ServerModelEntry[];
  problems: string[];
} {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { entries: [], problems: ["is not valid JSON."] };
  }
  const file = FileShape.safeParse(json);
  if (!file.success) {
    return {
      entries: [],
      problems: [
        `must be an object with a "models" list of at most ${MAX_SERVER_MODELS} entries.`,
      ],
    };
  }

  const problems: string[] = [];
  const entries: ServerModelEntry[] = [];
  const seen = new Set<string>();
  file.data.models.forEach((raw, index) => {
    const { name, default: isDefault, credentials, ...settings } = raw;
    const label =
      typeof name === "string" && name ? `entry "${name}"` : `entry ${index + 1}`;
    const problem = (message: string) => problems.push(`${label}: ${message}`);

    if (typeof name !== "string" || !SERVER_MODEL_NAME.test(name)) {
      problem(
        '"name" must be 1-40 lowercase letters, digits and dashes, starting with a letter or digit.',
      );
      return;
    }
    if (seen.has(name)) {
      problem("another entry has the same name.");
      return;
    }
    seen.add(name);
    if (isDefault !== undefined && typeof isDefault !== "boolean") {
      problem('"default" must be true or false.');
      return;
    }
    const provider = settings.provider;
    const kind = typeof provider === "string" ? providerKind(provider) : null;
    if (!kind) {
      problem(
        `"provider" must name a provider kind (${PROVIDER_KIND_NAMES.join(", ")}).`,
      );
      return;
    }
    const parsed = kind.settings.safeParse(settings);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      problem(
        issue.code === "unrecognized_keys"
          ? `${kind.label} takes no ${issue.keys.map((k) => `"${k}"`).join(", ")}.`
          : `"${String(issue.path[0] ?? "settings")}" ${issue.message}.`,
      );
      return;
    }

    const fields = credentialFields(kind);
    const named: Record<string, string> = {};
    if (credentials !== undefined) {
      if (
        credentials === null ||
        typeof credentials !== "object" ||
        Array.isArray(credentials)
      ) {
        problem(
          '"credentials" must map each secret field to an environment variable name.',
        );
        return;
      }
      for (const [field, variable] of Object.entries(credentials)) {
        if (!fields.some((f) => f.name === field)) {
          problem(
            fields.length > 0
              ? `"credentials.${field}" is not one of ${kind.label}'s fields (${fields.map((f) => f.name).join(", ")}).`
              : `${kind.label} takes no credentials.`,
          );
          return;
        }
        if (typeof variable !== "string" || !ENV_VAR_NAME.test(variable)) {
          problem(
            `"credentials.${field}" must be the name of an environment variable (UPPER_SNAKE_CASE), never the value itself.`,
          );
          return;
        }
        named[field] = variable;
      }
    }
    const missing = fields.filter((f) => !f.optional && !(f.name in named));
    if (missing.length > 0) {
      problem(
        `"credentials" must name a variable for ${missing.map((f) => `"${f.name}"`).join(", ")}.`,
      );
      return;
    }

    entries.push({
      name,
      id: `env:${name}`,
      settings: parsed.data as ModelSettings,
      credentials: named,
      default: isDefault === true,
    });
  });

  if (entries.filter((e) => e.default).length > 1) {
    problems.push(
      `more than one entry says "default": true (${entries
        .filter((e) => e.default)
        .map((e) => `"${e.name}"`)
        .join(", ")}); at most one may.`,
    );
  }
  return { entries, problems };
}

/**
 * Every problem with the file's text as a boot problem on `AI_MODELS_FILE`:
 * a shape error is fatal anywhere (the operator asked for these models), a
 * variable the file names but the environment lacks is fatal in production
 * and a warning in development (in demo mode, a warning), as `OPENAI_API_KEY`
 * is. Names variables, never values.
 */
export function checkServerModels(
  text: string,
  env: Readonly<Record<string, string | undefined>>,
  production: boolean,
): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const add = (severity: ConfigProblem["severity"], message: string) =>
    problems.push({ variable: "AI_MODELS_FILE", message, severity });
  const parsed = parseServerModels(text);
  for (const problem of parsed.problems) add("error", problem);
  if (parsed.problems.length > 0) return problems;

  const demo = env.AUTH_MODE === "demo";
  const legacy = Boolean(env.AI_PROVIDER || env.AI_MODEL);
  if (parsed.entries.length === 0 && !legacy) {
    add(
      production && !demo ? "error" : "warning",
      "lists no models and AI_PROVIDER/AI_MODEL name none; every generate request would fail.",
    );
  }
  for (const entry of parsed.entries) {
    if (entry.name === LEGACY_MODEL_NAME && legacy) {
      add(
        "error",
        `entry "${entry.name}": the name is taken by the model AI_PROVIDER/AI_MODEL describe; rename the entry or unset those variables.`,
      );
    }
    const unset = Object.values(entry.credentials).filter((variable) => !env[variable]);
    if (unset.length > 0) {
      add(
        production && !demo ? "error" : "warning",
        `entry "${entry.name}": ${unset.join(" and ")} ${unset.length > 1 ? "are" : "is"} not set, so the model cannot be called.`,
      );
    }
    if (kindOf(entry.settings).developmentOnly) {
      if (production && env.AI_STUB_IN_PRODUCTION !== "true") {
        add(
          "error",
          `entry "${entry.name}" is the stub, which answers with recorded specs and never calls a model; set AI_STUB_IN_PRODUCTION=true if this server is the end-to-end suite's.`,
        );
      } else {
        add("warning", `entry "${entry.name}" is the stub; it never calls a model.`);
      }
    }
  }
  return problems;
}
