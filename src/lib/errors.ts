/**
 * The shared error contract between routes, the poller, and the UI.
 *
 * Invariant 16 draws the line the product cares about: a statement-level SQL
 * failure is the user's query to fix, so its message is real and actionable; a
 * connection or infrastructure failure is not, so it stays opaque and the user
 * is handed a request id to quote instead. The server has always honoured the
 * split, but it expressed it only as a status code, which left every client
 * guessing from `400` vs `500` — and guessing badly, since a `400` is also how
 * a failed Zod parse and a tombstoned source arrive.
 *
 * `kind` makes the split explicit and machine-readable, so presentation is a
 * lookup rather than an inference. It never widens what is surfaced: the
 * opaque path still carries {@link OPAQUE_MESSAGE} and nothing else.
 */

export const ERROR_KINDS = [
  "validation",
  "statement",
  "authorization",
  "not_found",
  "conflict",
  "rate_limit",
  "infrastructure",
  "unknown",
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

/** The body every failed API response carries. */
export interface ApiError {
  error: string;
  kind: ErrorKind;
  /** Present when the request reached a handler; quoted in a bug report. */
  requestId?: string;
}

/**
 * What a 500 says, everywhere. The real message is written to the log with the
 * request id on it and never leaves the server.
 */
export const OPAQUE_MESSAGE = "Something went wrong on our end.";

/**
 * The kind a status code implies when a thrower did not name one.
 *
 * `400` defaults to `validation` rather than `statement`: the routes that raise
 * a statement failure say so explicitly, and a bad request body is the far more
 * common 400. Defaulting the other way would present a malformed payload as a
 * query the user can edit.
 */
export function kindFromStatus(status: number): ErrorKind {
  if (status >= 500) return "infrastructure";
  switch (status) {
    case 401:
    case 403:
      return "authorization";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 429:
      return "rate_limit";
    default:
      return status >= 400 ? "validation" : "infrastructure";
  }
}

/**
 * Whether the message is the user's to act on. Everything except an
 * infrastructure failure is: even an authorization denial tells them who to
 * ask. This is the one place the actionable/opaque split is decided.
 *
 * `unknown` counts as actionable because it means "a message arrived that this
 * client could not classify", not "a message arrived that must not be shown" —
 * withholding it would hide a perfectly good server sentence. Nothing the
 * server emits is ever `unknown`; the opaque path is `infrastructure`, and it
 * is the server that decides a failure belongs there.
 */
export function isActionable(kind: ErrorKind): boolean {
  return kind !== "infrastructure";
}

/** A parsed error ready to render. */
export interface ErrorPresentation {
  kind: ErrorKind;
  actionable: boolean;
  /** The real message when actionable, {@link OPAQUE_MESSAGE} when not. */
  message: string;
  /** The suggested next step, when there is a concrete one. */
  hint?: string;
  /** Shown only on the opaque path, where it is all the user can report. */
  requestId?: string;
}

const MISSING_TIME_FIELD = /^time column "[^"]*" is not produced by this query/;
const UNKNOWN_COLUMN = /column .* does not exist/i;
const UNKNOWN_RELATION = /relation .* does not exist/i;
const STATEMENT_TIMEOUT = /statement timeout|canceling statement due to/i;

/**
 * The concrete next step for a message we recognise.
 *
 * The `timeField` failure is the case worth singling out: `executePlan` already
 * rewrites Postgres' `42703` into a sentence that tells the user exactly what
 * to change, so it renders as the fix rather than as a second error blob.
 */
export function hintFor(kind: ErrorKind, message: string): string | undefined {
  switch (kind) {
    case "statement":
      if (MISSING_TIME_FIELD.test(message)) {
        return "Alias the time bucket in your SELECT to the panel's time field, or clear the time field if the result has no time column.";
      }
      if (UNKNOWN_COLUMN.test(message) || UNKNOWN_RELATION.test(message)) {
        return "Check the name against the source's catalog — only allowlisted tables and columns resolve.";
      }
      if (STATEMENT_TIMEOUT.test(message)) {
        return "Narrow the time range or aggregate with time_bucket, then run it again.";
      }
      return "Edit the query and run it again.";
    case "validation":
      return "Correct the highlighted value and try again.";
    case "authorization":
      return "Ask a workspace admin to grant you access.";
    case "not_found":
      return "It may have been deleted. Reload and try again.";
    case "conflict":
      return "The data source was removed. Point this panel at a source that still exists.";
    case "rate_limit":
      // The server message already names the limit and when it resets.
      return "Wait for the limit to reset, then retry.";
    case "infrastructure":
    case "unknown":
      // Nothing specific is known, and a guessed next step is worse than none.
      return undefined;
  }
}

/**
 * Turn an error body into something renderable.
 *
 * The opaque path is enforced here, not at the call site: an infrastructure
 * kind discards whatever message it arrived with. A client cannot leak what it
 * was never given, but this keeps the guarantee true even if a future server
 * change is careless.
 */
export function presentError(err: ApiError): ErrorPresentation {
  const actionable = isActionable(err.kind);
  const message = actionable ? err.error : OPAQUE_MESSAGE;
  return {
    kind: err.kind,
    actionable,
    message,
    hint: hintFor(err.kind, message),
    requestId: actionable ? undefined : err.requestId,
  };
}

/**
 * Normalize a failed `fetch` into an {@link ApiError}.
 *
 * A route always answers JSON, but a proxy, a crash, or a redirect to the login
 * page does not — so an unparseable body is treated as the infrastructure
 * failure it almost certainly is rather than rendered raw.
 */
export function apiErrorFrom(
  status: number,
  body: unknown,
  requestId?: string,
): ApiError {
  const record =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const message = typeof record.error === "string" ? record.error : undefined;
  const kind = isErrorKind(record.kind) ? record.kind : kindFromStatus(status);
  const id = typeof record.requestId === "string" ? record.requestId : requestId;
  return {
    error: message ?? OPAQUE_MESSAGE,
    kind: message === undefined ? "infrastructure" : kind,
    requestId: id,
  };
}

function isErrorKind(value: unknown): value is ErrorKind {
  return typeof value === "string" && (ERROR_KINDS as readonly string[]).includes(value);
}

/** Read a failed `Response`, including the request id the route stamps on it. */
export async function readApiError(res: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return apiErrorFrom(res.status, body, res.headers.get("x-request-id") ?? undefined);
}

/**
 * Best effort for an error that never went through {@link readApiError}.
 *
 * The streaming hooks (`useObject`) do not expose the `Response`, only an
 * `Error` — but for a non-OK response the AI SDK puts the raw response body in
 * its message, and our routes answer JSON. So the body is worth one parse
 * attempt: it recovers the real `kind` and request id for a rate-limited or
 * denied generation, which is most of what goes wrong on those routes.
 *
 * When that fails the message is shown as-is under `unknown` rather than
 * guessed at. A thrown error with no message at all has nothing to show.
 */
export function apiErrorFromThrown(err: unknown): ApiError {
  if (!(err instanceof Error) || !err.message) {
    return { error: OPAQUE_MESSAGE, kind: "infrastructure" };
  }
  const embedded = parseJsonBody(err.message);
  if (embedded && typeof embedded.error === "string") {
    return {
      error: embedded.error,
      // A body that names no kind is not evidence of an infrastructure
      // failure — it is a body this client cannot classify — so it stays
      // `unknown` and keeps its message.
      kind: isErrorKind(embedded.kind) ? embedded.kind : "unknown",
      requestId: typeof embedded.requestId === "string" ? embedded.requestId : undefined,
    };
  }
  return { error: err.message, kind: "unknown" };
}

function parseJsonBody(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
