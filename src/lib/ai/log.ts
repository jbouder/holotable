import { createHash } from "node:crypto";
import type { LanguageModelUsage } from "ai";
import { config } from "@/lib/config";
import { insertGenerationLog } from "@/lib/db/repo";
import { tokensFromUsage } from "@/lib/limits/budget";
import { log, redactString } from "@/lib/log";

/**
 * The generation log (#23).
 *
 * Every model call made on an author's behalf leaves one row: what was asked,
 * which catalog was in context, what came back, and what it cost. It exists so
 * that "the dashboard it generated is wrong" is an answerable complaint, and
 * it is the corpus the eval harness (#24) will read.
 *
 * It is a WRITE-path concern only. `recordGeneration` is called from a
 * stream's finish callback and never from a read; it never throws and never
 * delays a response, because a log that can fail a generation is worse than no
 * log. Everything above the database call is a pure function so the redaction
 * is testable without one.
 *
 * What is deliberately NOT stored:
 *
 *  - credentials, in any shape the redaction pass recognizes (invariant 5);
 *  - the rendered catalog, which is reduced to a hash -- "was this the same
 *    catalog?" is the question a log answers, and the text is not needed for it;
 *  - anything on a client payload. The only reader is /api/generation-log,
 *    behind `source:manage`.
 */

/** Which author action produced the call. Mirrors the migration's CHECK. */
export type GenerationMode =
  | "dashboard"
  | "dashboard-refine"
  | "panel"
  | "explore"
  | "source-draft";

/**
 * Credential shapes worth removing from a typed prompt but NOT from a log
 * line, which is why they live here rather than in `redactString`.
 *
 * A log line is full of long opaque identifiers that mean something -- a
 * request id, a session subject, a spec fingerprint, a sha -- and eating them
 * would make the log useless to the person reading it. A prompt is a sentence
 * someone typed about their metrics; a 40-character hex run in one is far more
 * likely to be a pasted token than anything worth keeping.
 */
const PROMPT_SCRUBBERS: ReadonlyArray<[RegExp, string]> = [
  // An environment variable that names a secret, with its value:
  // `TS_METRICS_PASSWORD=hunter2`, `"OPENAI_API_KEY": "sk-…"`. `redactString`
  // matches the generic `password=` spelling but anchors the key name on a word
  // boundary, so `_API_KEY` inside an UPPER_SNAKE name slips past it; this rule
  // is the *_KEY / *_TOKEN / *_SECRET family. The separator is required: without
  // it the rule would swallow the next word of an ordinary sentence about the
  // variable, and a bare pasted value is caught by the two rules below anyway.
  [
    /\b([A-Z][A-Z0-9_]*_(?:API_KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?))\b["']?\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/g,
    "$1=[redacted]",
  ],
  // A long base64/base64url run: a key, a cookie, an encoded blob.
  [/\b[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/_=-])/g, "[redacted]"],
  // A long hex run: an API key, a digest, a raw token.
  [/\b[0-9a-fA-F]{32,}\b/g, "[redacted]"],
];

/** A prompt as it is safe to keep: `redactString` plus {@link PROMPT_SCRUBBERS}. */
export function redactPrompt(prompt: string): string {
  let out = redactString(prompt);
  for (const [pattern, replacement] of PROMPT_SCRUBBERS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Longest prompt kept whole. Past this the tail is dropped, with a marker. */
export const MAX_LOGGED_PROMPT = 4_000;

/** Longest error message kept. A stack is not stored at all. */
export const MAX_LOGGED_ERROR = 1_000;

function clamp(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…(${value.length} chars)` : value;
}

/**
 * The rendered catalog as a fingerprint. Two rows with the same hash had the
 * same tables and columns in context; neither row carries either.
 */
export function catalogHash(catalog: string | null | undefined): string | null {
  if (!catalog) return null;
  return createHash("sha256").update(catalog).digest("hex").slice(0, 32);
}

/** A failure as it is safe to keep: the message, redacted and clamped. */
export function redactGenerationError(err: unknown): string | null {
  if (err === undefined || err === null) return null;
  const message = err instanceof Error ? err.message : String(err);
  if (!message) return null;
  return clamp(redactPrompt(message), MAX_LOGGED_ERROR);
}

/** What a caller knows about a finished generation, before redaction. */
export interface GenerationEvent {
  workspaceId: string;
  createdBy: string;
  mode: GenerationMode;
  /** The source the prompt was built against; null for a source draft. */
  sourceId: string | null;
  /** The prompt exactly as the author typed it. Redacted here, never stored raw. */
  prompt: string;
  /** The rendered catalog prompt, hashed here; null when there was none. */
  catalog: string | null;
  /** The validated spec, or null/undefined when the run produced none. */
  spec: unknown;
  model: string;
  usage?: LanguageModelUsage;
  /** Model calls this action made. One, unless a future repair loop says otherwise. */
  attempts?: number;
  error?: unknown;
}

/** One row of `generation_log`, with every value already safe to persist. */
export interface GenerationLogRow {
  workspaceId: string;
  createdBy: string;
  mode: GenerationMode;
  sourceId: string | null;
  promptRedacted: string;
  catalogHash: string | null;
  spec: unknown;
  model: string;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  error: string | null;
}

/**
 * Turn a finished generation into the row that will be written.
 *
 * Pure, and the single place redaction happens: every path into the table goes
 * through here, so a test that feeds it a connection string and asserts the
 * password is absent is a test of the table, not of one caller.
 */
export function generationRow(event: GenerationEvent): GenerationLogRow {
  const tokens = event.usage
    ? tokensFromUsage(event.usage)
    : { inputTokens: 0, outputTokens: 0 };
  return {
    workspaceId: event.workspaceId,
    createdBy: event.createdBy,
    mode: event.mode,
    sourceId: event.sourceId,
    promptRedacted: clamp(redactPrompt(event.prompt), MAX_LOGGED_PROMPT),
    catalogHash: catalogHash(event.catalog),
    // A run that failed has no spec. `undefined` and `null` both mean "none".
    spec: event.spec ?? null,
    // The provider's own id when it reported one, so a row says which model
    // actually answered rather than which one was configured.
    model: event.model || config.aiModel || "unknown",
    attempts: Math.max(1, Math.round(event.attempts ?? 1)),
    ...tokens,
    error: redactGenerationError(event.error),
  };
}

/**
 * A stored row as the admin reader sees it. `spec` stays `unknown`: it is a
 * historical record, not something the app is about to render, so it is not
 * re-parsed against today's IR -- a row written before an IR change is
 * precisely what someone reading this log is looking for.
 */
export interface GenerationLogEntry extends GenerationLogRow {
  id: string;
  createdAt: string;
}

/** Rows per page when the caller does not ask, and the ceiling when it does. */
export const GENERATION_LOG_PAGE = 50;
export const GENERATION_LOG_MAX_PAGE = 200;

/** A `?limit=` query parameter as a row count. Anything unusable is the default. */
export function generationLogLimit(raw: string | null | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return GENERATION_LOG_PAGE;
  return Math.min(Math.floor(n), GENERATION_LOG_MAX_PAGE);
}

/** How a row reaches storage. Swapped in tests; `insertGenerationLog` in production. */
export type GenerationLogWriter = (
  row: GenerationLogRow,
  retentionDays: number,
) => Promise<void>;

/**
 * Persist one finished generation.
 *
 * Fire-and-forget by design: the caller is a stream callback on the response
 * path, and a slow or broken config store must not hold a dashboard hostage.
 * A failure is logged and dropped, exactly as the LLM usage recorder does.
 */
export function recordGeneration(
  event: GenerationEvent,
  write: GenerationLogWriter = insertGenerationLog,
): void {
  let row: GenerationLogRow;
  try {
    row = generationRow(event);
  } catch (err) {
    log.error("generation.log_build_failed", { mode: event.mode, err });
    return;
  }
  void write(row, config.generationLogRetentionDays).catch((err: unknown) => {
    log.error("generation.log_write_failed", { mode: row.mode, model: row.model, err });
  });
}
