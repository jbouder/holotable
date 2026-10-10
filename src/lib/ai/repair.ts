import { NoObjectGeneratedError } from "ai";
import type { z } from "zod";
import { fenceUntrustedBlock, sanitizePromptField } from "@/lib/ai/untrusted";

/**
 * The bounded structured-output repair (#21).
 *
 * When a generation's output fails the schema, the author gets one automatic
 * re-ask that shows the model its own output and what was wrong with it,
 * instead of losing the whole turn to a single bad field. Exactly one: the
 * repair's own failure is final.
 *
 * The generation streams to the browser as it is written, so by the time the
 * server knows it failed, the browser already holds it. The repair is
 * therefore a second request, which the browser makes automatically
 * (`useRepairingObject`), naming the failed generation by the id the first
 * response carried in {@link GENERATION_ID_HEADER}. Everything that request
 * acts on comes from this module's store, never from the browser: the original
 * request, the output that failed and the issues, which the server computed
 * itself against the real schema. Taking an entry removes it, which is what
 * makes it one repair per generation.
 *
 * The store is process-local, like session revocation, because the app is one
 * instance by design. A restart, or a repair asked for after
 * {@link FAILURE_TTL_MS}, finds nothing, and the author sees the failure and
 * Try again, as before.
 */

export { GENERATION_ID_HEADER } from "@/lib/ai/generation-id";

/** The 404 a repair request gets when there is nothing (left) to repair. */
export const NOTHING_TO_REPAIR =
  "There is no failed answer to repair: it expired, or the model never finished one. Generate again.";

/** How long a failed generation can still be repaired. */
export const FAILURE_TTL_MS = 5 * 60_000;
/** Failed generations held at once; the oldest is dropped past this. */
const MAX_PENDING = 500;
/** The most of the rejected output shown back to the model. */
const MAX_REJECTED_CHARS = 16_000;
/** The most validation issues listed, and the length of each. */
const MAX_ISSUES = 20;
const MAX_ISSUE_CHARS = 300;

/** Why an output failed, as the server worked it out. */
export interface Failure {
  /** The model's output, as text. */
  text: string;
  /** One line per problem: `path: message`, or why it is not JSON at all. */
  issues: string[];
}

/** What the repair request needs to run the original request again. */
export interface PendingRepair<Request> {
  /** The identity that made the original request; only it may repair. */
  sub: string;
  /** Which route took the original, so a draft cannot be replayed as a dashboard. */
  route: "generate" | "source-draft";
  /** The original, already-validated request body. */
  request: Request;
  failure: Failure;
}

interface Entry {
  pending: PendingRepair<unknown>;
  expiresAt: number;
}

const CACHE_KEY = Symbol.for("holotable.pendingRepairs");
type Cache = { [CACHE_KEY]?: Map<string, Entry> };

/** Shared across bundles on `globalThis`, as the metrics registry is. */
function store(): Map<string, Entry> {
  const cache = globalThis as Cache;
  cache[CACHE_KEY] ??= new Map();
  return cache[CACHE_KEY];
}

/**
 * Work out why `error` failed, from the output text it carries, against
 * `schema`. Null when the failure was not about the output's shape (a
 * provider error, a timeout, an empty answer): there is nothing to repair.
 */
export async function describeFailure(
  error: unknown,
  schema: z.ZodType,
): Promise<Failure | null> {
  if (!NoObjectGeneratedError.isInstance(error) || !error.text?.trim()) return null;
  const text = error.text;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (parseError) {
    const reason = parseError instanceof Error ? parseError.message : "malformed JSON";
    return { text, issues: [`The output is not valid JSON: ${reason}`] };
  }
  // Async: a generation schema may compile a custom visual (#405).
  const result = await schema.safeParseAsync(value);
  if (result.success) return null;
  return {
    text,
    issues: result.error.issues.slice(0, MAX_ISSUES).map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    }),
  };
}

/** Hold a failed generation so one repair request can take it. */
export function rememberFailure<Request>(
  generationId: string,
  pending: PendingRepair<Request>,
  now: number = Date.now(),
): void {
  const pendingRepairs = store();
  for (const [id, entry] of pendingRepairs) {
    if (entry.expiresAt <= now) pendingRepairs.delete(id);
  }
  while (pendingRepairs.size >= MAX_PENDING) {
    const oldest = pendingRepairs.keys().next().value;
    if (oldest === undefined) break;
    pendingRepairs.delete(oldest);
  }
  pendingRepairs.set(generationId, { pending, expiresAt: now + FAILURE_TTL_MS });
}

/**
 * Take the failed generation `generationId`, if `sub` made it on `route` and
 * it has not expired. Taking removes it: a second repair finds nothing. An
 * entry asked for by someone else is left where it is.
 */
export function takeFailure<Request>(
  generationId: string,
  sub: string,
  route: PendingRepair<Request>["route"],
  now: number = Date.now(),
): PendingRepair<Request> | null {
  const pendingRepairs = store();
  const entry = pendingRepairs.get(generationId);
  if (!entry || entry.pending.sub !== sub || entry.pending.route !== route) return null;
  pendingRepairs.delete(generationId);
  if (entry.expiresAt <= now) return null;
  return entry.pending as PendingRepair<Request>;
}

/** For tests. */
export function clearPendingRepairs(): void {
  store().clear();
}

/**
 * The original prompt, followed by the failed output and its problems. Both
 * are fenced as data: the output was written by a model that may have been
 * steered by the catalog or the request, and the issues quote it.
 */
export function repairPrompt(prompt: string, failure: Failure): string {
  const issues = failure.issues
    .map((issue) => `- ${sanitizePromptField(issue, MAX_ISSUE_CHARS)}`)
    .join("\n");
  const rejected = sanitizePromptField(failure.text, MAX_REJECTED_CHARS);
  return `${prompt}

Your previous answer to this request was REJECTED because it does not match the
required schema. The answer and the problems found in it follow.

${fenceUntrustedBlock("REJECTED_OUTPUT", rejected)}

${fenceUntrustedBlock("VALIDATION_ISSUES", issues)}

Return the COMPLETE corrected object. Fix every listed problem, keep everything
else that was correct, and follow all of the rules above.`;
}
