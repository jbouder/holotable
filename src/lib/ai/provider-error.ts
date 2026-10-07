import { baseUrlRefusal } from "@/lib/ai/guarded-fetch";
import { APICallError, createTextStreamResponse } from "ai";
import { HttpError } from "@/lib/auth/authorize";
import { ModelTimeoutError } from "@/lib/ai/invoke";
import { currentRequest, log, runWithRequest } from "@/lib/log";

/**
 * What an author is told when the model provider fails (#337).
 *
 * A provider's own reply is not passed through: it can quote the request, name
 * an account, or echo part of a key. The author gets a sentence that names the
 * setting to change, and the server log gets the provider's reply (redacted by
 * the logger like every other field).
 *
 * The case worth naming is the one an operator cannot guess from a status
 * code: an OpenAI-compatible aggregator (OpenCode Zen, for one) lists a model
 * at `/models` that does not speak the protocol `OPENAI_API` selects, and
 * answers every request with "Model does not support this protocol".
 */

const PROTOCOL_MISMATCH =
  /does not support this protocol|protocol (?:is )?not supported|unsupported (?:api|protocol)/i;

export const PROTOCOL_MISMATCH_MESSAGE =
  'The model provider says the model in AI_MODEL does not support the API this server calls it with. Set OPENAI_API to "chat" (Chat Completions) or "responses" (Responses API) to match what the provider offers for that model, or choose another AI_MODEL.';

/** True when the provider refused the request because of the protocol, not the request. */
export function isProtocolMismatch(error: unknown): boolean {
  if (!APICallError.isInstance(error)) return false;
  return PROTOCOL_MISMATCH.test(`${error.message} ${error.responseBody ?? ""}`);
}

/** The sentence an author sees for a provider failure. Safe to send to a browser. */
export function providerErrorMessage(error: unknown): string {
  if (error instanceof ModelTimeoutError) return error.message;
  // Written for the person who configured the base URL (#331), and names no
  // more than the host they typed and the address it resolved to.
  const refusal = baseUrlRefusal(error);
  if (refusal) return refusal.message;
  if (isProtocolMismatch(error)) return PROTOCOL_MISMATCH_MESSAGE;
  if (APICallError.isInstance(error) && error.statusCode !== undefined) {
    return `The model provider refused the request (HTTP ${error.statusCode}). The server log has its reply.`;
  }
  return "The model provider could not be reached or did not answer. The server log has the details.";
}

/**
 * A provider failure as the response a route answers with. It does not log:
 * {@link logModelErrors} already has, from the model call itself.
 */
export function providerHttpError(error: unknown): HttpError {
  const status = error instanceof ModelTimeoutError ? 504 : 502;
  return new HttpError(status, providerErrorMessage(error), {}, "infrastructure");
}

/**
 * The `onError` every `streamObject`/`streamText` call carries, through
 * `modelSettings()` (#343). It is the one place a failed model call is
 * logged: before output starts, when the route turns it into an error
 * response, and after, when nothing else sees it.
 *
 * Without it the SDK's default prints the raw error to the console: the
 * request body (prompt, catalog and schema included), the provider's reply
 * and its headers, as multi-line text that never went through the log's
 * redaction.
 *
 * The request's context is captured when the call is made, because the
 * stream is read, and so fails, wherever the response body is being piped
 * from, which is outside the route's own async context.
 */
export function logModelErrors(): (event: { error: unknown }) => void {
  const ctx = currentRequest();
  return ({ error }) => {
    // A browser that stops the generation aborts the call; nothing failed.
    if (error instanceof Error && error.name === "AbortError") return;
    const write = () =>
      log.error("model.request_failed", {
        err: error,
        status: APICallError.isInstance(error) ? error.statusCode : undefined,
        protocolMismatch: isProtocolMismatch(error),
      });
    if (ctx) runWithRequest(ctx, write);
    else write();
  };
}

/** The parts of a structured generation's `fullStream` this reads. */
type ObjectPart =
  | { type: "text-delta"; textDelta: string }
  | { type: "error"; error: unknown }
  | { type: string };

/**
 * A structured generation as a text response, answered only once the model
 * has started. It stands in for `toTextStreamResponse`.
 *
 * A route streams the model's output as the body of a 200. If the provider
 * refused the request, there was no output to stream: the browser got an
 * empty 200, read it as an answer that failed its schema, and asked for a
 * repair there was nothing to make. Reading up to the first output first lets
 * a refusal become an error response that says what went wrong (#337). The
 * retry and the deadline (#22) have already run by then, so the refusal is
 * final.
 *
 * The SDK's streams all read one underlying stream, so this reads
 * `fullStream` itself and carries on from where it stopped, sending the text
 * exactly as `toTextStreamResponse` would. As there, an error after the
 * output has started ends the body; the browser validates what arrived.
 */
export async function textResponseOnceStarted(
  result: { fullStream: ReadableStream<ObjectPart> },
  headers?: Record<string, string>,
): Promise<Response> {
  const reader = result.fullStream.getReader();
  const started: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.type === "error" && "error" in value) {
      reader.cancel().catch(() => {});
      throw providerHttpError(value.error);
    }
    if (value.type === "text-delta" && "textDelta" in value) {
      started.push(value.textDelta);
      break;
    }
  }
  const stream = new ReadableStream<string>({
    start(controller) {
      for (const text of started) controller.enqueue(text);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else if (value.type === "text-delta" && "textDelta" in value) {
        controller.enqueue(value.textDelta);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return createTextStreamResponse({ stream, headers });
}
