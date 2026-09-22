import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";

/**
 * Structured logging.
 *
 * Every line the server emits is one JSON object on stdout carrying a level, a
 * timestamp, a message, and the id of the request that produced it. That makes
 * the log greppable (`jq 'select(.requestId=="…")'`), aggregatable, and
 * correlatable with a user's bug report, none of which `console.error` was.
 *
 * Four things hold here.
 *
 * 1. **No call site threads a logger.** The request-scoped fields — request id,
 *    trace and span ids, workspace, subject, route — live in an
 *    `AsyncLocalStorage` entered once per request by {@link runWithRequest}
 *    (which `route()` in `src/lib/http.ts` calls for every API handler). A log
 *    call anywhere beneath it picks them up automatically.
 *
 * 2. **Nothing is logged verbatim.** Every payload goes through
 *    {@link redactFields} before serialization: credential-shaped substrings
 *    are scrubbed out of strings, secret-shaped keys are replaced wholesale,
 *    and SQL and prompt text is reduced to a hash plus a length. A statement or
 *    a prompt is often the most useful thing to correlate on and the most
 *    dangerous thing to keep, and a digest is both.
 *
 * 3. **It is a sink, not a dependency.** This module reads `LOG_LEVEL` and
 *    `LOG_FORMAT` straight from the environment rather than through
 *    `src/lib/config.ts`. It has to work inside `instrumentation.ts` before the
 *    configuration has been validated, and a logger that imports the config
 *    module is a logger the config module can never use. Both variables are
 *    still checked at startup by `validateConfig`.
 *
 * 4. **No dependency.** The two hard requirements here — value-shaped
 *    redaction, and request context across async boundaries — are custom work
 *    under any logging library, since `pino`'s `redact` matches *paths* and
 *    these route handlers are not an Express app. What is left is level
 *    filtering and JSON serialization at a few hundred lines a second. See the
 *    pull request for #52 for the full trade.
 */

/* -------------------------------------------------------------------------- */
/* Levels                                                                     */
/* -------------------------------------------------------------------------- */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Levels in order, plus the `silent` threshold that admits nothing. */
const SEVERITY: Record<LogLevel | "silent", number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type LogLevelSetting = (typeof LOG_LEVELS)[number];

export const LOG_FORMATS = ["json", "pretty"] as const;
export type LogFormat = (typeof LOG_FORMATS)[number];

function isLevelSetting(v: string): v is LogLevelSetting {
  return (LOG_LEVELS as readonly string[]).includes(v);
}

function isFormat(v: string): v is LogFormat {
  return (LOG_FORMATS as readonly string[]).includes(v);
}

/* -------------------------------------------------------------------------- */
/* Redaction                                                                  */
/* -------------------------------------------------------------------------- */

/** The stand-in for anything removed. Distinctive enough to grep for. */
export const REDACTED = "[redacted]";

/**
 * Keys whose value is a secret whatever it looks like. Deliberately spelled
 * out rather than matching a bare `token`, which would swallow the `inputTokens`
 * and `outputTokens` counts that the LLM limits legitimately log.
 */
const SECRET_KEY =
  /password|passwd|\bpwd\b|secret|api[_-]?key|apikey|authorization|credentials?|cookie|private[_-]?key|access[_-]?token|id[_-]?token|refresh[_-]?token|session[_-]?token|bearer|\bjwt\b/i;

/**
 * Keys that match {@link SECRET_KEY} but name a secret rather than holding one.
 * `secretRef` is the env-variable family a source draws its credentials from
 * (`TS_METRICS`), which is exactly the thing an operator needs in a log line.
 */
const NOT_SECRET_KEY = /^secret_?refs?$/i;

/**
 * Keys whose value is free text the model or the user wrote. Logged as a
 * digest: enough to prove two requests carried the same statement, not enough
 * to leak what it said or the credential someone inlined into it.
 */
const DIGEST_KEY = /^(sql|statement|prompts?|messages?|catalog)$/i;

/** Credential shapes that show up inside otherwise ordinary strings. */
const STRING_SCRUBBERS: ReadonlyArray<[RegExp, string]> = [
  // postgres://user:pass@host — keep the scheme and user, drop the password.
  [/\b([a-z][a-z0-9+.-]*):\/\/([^\s/@:]+):([^\s/@]*)@/gi, `$1://$2:${REDACTED}@`],
  // password=…, "api_key": "…", authorization=… in DSNs, query strings, and
  // stringified JSON. The optional quote is what makes the JSON case work:
  // the key's closing `"` sits between the name and the separator.
  [
    /\b(password|passwd|pwd|secret|api[_-]?key|apikey|authorization|credentials?)\b["']?\s*[=:]\s*("[^"]*"|'[^']*'|(?:bearer|basic)\s+[^\s,;&)]+|[^\s,;&)]+)/gi,
    `$1=${REDACTED}`,
  ],
  // A bare credential with no key in front of it — an `Authorization` value
  // quoted on its own. The rule above consumes the keyed form, scheme and all,
  // which is why that one has to match the scheme word too.
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // A JWT — a session cookie, an id_token, or a provider key.
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // Provider API keys that carry their own prefix.
  [/\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, REDACTED],
];

/** Caps that keep one pathological payload from producing an unreadable line. */
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 2_000;

/** Scrub credential shapes out of a single string value. */
export function redactString(value: string): string {
  let out = value;
  for (const [pattern, replacement] of STRING_SCRUBBERS) {
    out = out.replace(pattern, replacement);
  }
  if (out.length > MAX_STRING_LENGTH) {
    out = `${out.slice(0, MAX_STRING_LENGTH)}…(${out.length} chars)`;
  }
  return out;
}

/**
 * Reduce free text to something safe to keep: a truncated SHA-256 and the
 * original length. Two log lines carrying the same digest ran the same
 * statement; neither line carries the statement.
 */
export function digest(value: string): { sha256: string; length: number } {
  return {
    sha256: createHash("sha256").update(value).digest("hex").slice(0, 16),
    length: value.length,
  };
}

function redactError(err: Error): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: err.name,
    message: redactString(err.message),
  };
  if (err.stack) out.stack = redactString(err.stack);
  if (err.cause !== undefined) out.cause = redactValue(err.cause, MAX_DEPTH - 1);
  // `pg` and Node socket errors carry the useful part here.
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") out.code = code;
  return out;
}

function redactValue(value: unknown, depth: number, key?: string): unknown {
  if (key !== undefined && !NOT_SECRET_KEY.test(key) && SECRET_KEY.test(key)) {
    return REDACTED;
  }
  if (key !== undefined && DIGEST_KEY.test(key)) {
    return digest(typeof value === "string" ? value : (JSON.stringify(value) ?? ""));
  }
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return depth <= 0 ? value.name : redactError(value);
  if (depth <= 0) return "[truncated]";

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((v) => redactValue(v, depth - 1));
    return value.length > MAX_ARRAY_ITEMS
      ? [...items, `…${value.length - MAX_ARRAY_ITEMS} more`]
      : items;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const redacted = redactValue(v, depth - 1, k);
      if (redacted !== undefined) out[k] = redacted;
    }
    return out;
  }
  return String(value);
}

/** Redact a whole field payload. Exported for the tests that prove it works. */
export function redactFields(fields: Fields): Record<string, unknown> {
  const out = redactValue(fields, MAX_DEPTH);
  return out && typeof out === "object" ? (out as Record<string, unknown>) : {};
}

/* -------------------------------------------------------------------------- */
/* Request context                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The fields every line emitted while serving one request carries. Mutable on
 * purpose: `requireIdentity` and `assertAuthorized` learn the subject and the
 * workspace part-way through, and amending the store is how they attach those
 * to lines that have not been written yet without threading a logger down.
 */
export interface RequestContext {
  requestId: string;
  /** The stable route name, never the concrete path — ids are not labels. */
  route: string;
  method: string;
  traceId?: string;
  spanId?: string;
  workspaceId?: string;
  /** The identity's `sub` claim, once the request has been authenticated. */
  sub?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** The context of the request being served here, if there is one. */
export function currentRequest(): RequestContext | undefined {
  return storage.getStore();
}

/** Run `fn` with `ctx` attached to every log line beneath it. */
export function runWithRequest<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Amend the current request's context. A no-op outside a request, so a helper
 * that also runs in the poller or a script does not have to care.
 */
export function amendRequest(fields: Partial<Omit<RequestContext, "requestId">>): void {
  const ctx = storage.getStore();
  if (!ctx) return;
  Object.assign(ctx, fields);
}

/**
 * A request id is echoed back to the caller, so an inbound one is only
 * accepted when it cannot turn into a header-injection or an unbounded string.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Reuse the caller's `x-request-id` when it is safe to echo, else mint one. */
export function requestIdFrom(headers: Headers): string {
  const presented = headers.get("x-request-id");
  if (presented && SAFE_REQUEST_ID.test(presented)) return presented;
  return randomUUID();
}

/**
 * W3C `traceparent`: `00-<32 hex trace id>-<16 hex span id>-<flags>`. Parsed
 * here so a request arriving from an already-instrumented caller correlates
 * today; when real tracing lands (#50) the exporter becomes the source of
 * these and this stays the fallback for the un-instrumented hop.
 */
const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

export function traceContextFrom(
  headers: Headers,
): { traceId: string; spanId: string } | undefined {
  const match = TRACEPARENT.exec(headers.get("traceparent")?.trim().toLowerCase() ?? "");
  if (!match) return undefined;
  // An all-zero id is the spec's "invalid" sentinel.
  if (/^0+$/.test(match[1]) || /^0+$/.test(match[2])) return undefined;
  return { traceId: match[1], spanId: match[2] };
}

/** Build the context for one inbound request. */
export function newRequestContext(
  req: Request,
  route: string,
  method = req.method,
): RequestContext {
  return {
    requestId: requestIdFrom(req.headers),
    route,
    method,
    ...traceContextFrom(req.headers),
  };
}

/* -------------------------------------------------------------------------- */
/* The logger                                                                 */
/* -------------------------------------------------------------------------- */

export type Fields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  /** A logger that adds `fields` to every line it writes. */
  child(fields: Fields): Logger;
}

export interface LoggerOptions {
  level?: LogLevelSetting;
  format?: LogFormat;
  /** Where a finished line goes. Defaults to stdout; tests capture it. */
  sink?: (line: string) => void;
  now?: () => Date;
  /** Colour the level in `pretty` output. Defaults to whether stdout is a TTY. */
  color?: boolean;
  /** Read `LOG_LEVEL`/`LOG_FORMAT` from here when they are not passed. */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Everything goes to stdout, including errors: a log line is an event, not a
 * failure of the process, and splitting the stream by level means a container
 * runtime interleaves the two unpredictably. Consumers filter on `level`.
 *
 * The guard is for the case where a client bundle somehow reaches this module:
 * dropping the line is better than throwing inside a render.
 */
const stdout = (line: string): void => {
  if (typeof process !== "undefined" && typeof process.stdout?.write === "function") {
    process.stdout.write(`${line}\n`);
  }
};

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: "\x1b[2m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};

function formatPretty(
  level: LogLevel,
  time: Date,
  message: string,
  fields: Record<string, unknown>,
  color: boolean,
): string {
  const clock = time.toISOString().slice(11, 23);
  const tag = level.toUpperCase().padEnd(5);
  const head = color ? `${LEVEL_COLOR[level]}${tag}\x1b[0m` : tag;

  const inline: string[] = [];
  const blocks: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    // A multi-line string is a report meant for a human (the startup config
    // report is the one that matters); keep it readable instead of escaping it.
    if (typeof value === "string" && value.includes("\n")) {
      blocks.push(
        value
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n"),
      );
      continue;
    }
    inline.push(
      `${key}=${typeof value === "string" ? value : (JSON.stringify(value) ?? "?")}`,
    );
  }

  const first = `${clock} ${head} ${message}${inline.length ? ` ${inline.join(" ")}` : ""}`;
  return blocks.length ? [first, ...blocks].join("\n") : first;
}

/**
 * Build a logger. The default export {@link log} is one of these, built from
 * the environment; tests build their own with a capturing sink.
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const env = opts.env ?? (typeof process !== "undefined" ? process.env : {});
  const rawLevel = (env.LOG_LEVEL ?? "").trim().toLowerCase();
  const rawFormat = (env.LOG_FORMAT ?? "").trim().toLowerCase();
  const development = env.NODE_ENV !== "production";

  const level: LogLevelSetting =
    opts.level ?? (isLevelSetting(rawLevel) ? rawLevel : development ? "debug" : "info");
  const format: LogFormat =
    opts.format ?? (isFormat(rawFormat) ? rawFormat : development ? "pretty" : "json");
  const sink = opts.sink ?? stdout;
  const now = opts.now ?? (() => new Date());
  const color =
    opts.color ??
    (format === "pretty" &&
      typeof process !== "undefined" &&
      process.stdout?.isTTY === true);
  const threshold = SEVERITY[level];

  const make = (bound: Fields): Logger => {
    const write = (lvl: LogLevel, message: string, fields?: Fields): void => {
      if (SEVERITY[lvl] < threshold) return;
      const time = now();
      const ctx = currentRequest();
      const payload = redactFields({ ...bound, ...fields });
      const record: Record<string, unknown> = {
        level: lvl,
        time: time.toISOString(),
        msg: message,
        ...(ctx
          ? {
              requestId: ctx.requestId,
              route: ctx.route,
              ...(ctx.traceId ? { traceId: ctx.traceId, spanId: ctx.spanId } : {}),
              ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
              ...(ctx.sub ? { sub: ctx.sub } : {}),
            }
          : {}),
        ...payload,
      };
      if (format === "json") {
        sink(JSON.stringify(record));
        return;
      }
      const { level: _l, time: _t, msg: _m, ...rest } = record;
      sink(formatPretty(lvl, time, message, rest, color));
    };

    return {
      debug: (m, f) => write("debug", m, f),
      info: (m, f) => write("info", m, f),
      warn: (m, f) => write("warn", m, f),
      error: (m, f) => write("error", m, f),
      child: (fields) => make({ ...bound, ...fields }),
    };
  };

  return make({});
}

/**
 * The logger every module writes through.
 *
 * It forwards to whatever {@link setLogger} last installed rather than being a
 * logger itself, so that a module holding `import { log }` from load time still
 * writes to a logger swapped in afterwards. That is what lets a test assert on
 * the lines a module produces — `enforceLlmLimits` logging a failed usage write
 * is part of its contract — without every module taking a logger parameter.
 */
let current: Logger = createLogger();

export const log: Logger = {
  debug: (m, f) => current.debug(m, f),
  info: (m, f) => current.info(m, f),
  warn: (m, f) => current.warn(m, f),
  error: (m, f) => current.error(m, f),
  child: (f) => current.child(f),
};

/** Install a logger. Returns a function that puts the previous one back. */
export function setLogger(next: Logger): () => void {
  const previous = current;
  current = next;
  return () => {
    current = previous;
  };
}
