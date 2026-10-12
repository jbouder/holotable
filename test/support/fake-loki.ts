import {
  type Answer,
  type FakePrometheus,
  type SeenRequest,
  startFakePrometheus,
} from "./fake-prometheus";

/**
 * A Loki-shaped HTTP endpoint on a loopback port (#562), for the tests of the
 * client, the executor, refresh and the connection test. It is the fake
 * Prometheus's server with Loki's answers: every request is recorded with its
 * method, so a client that sent a POST where real Loki says 405 is caught,
 * and `handle` decides the answer by path. Import `./loki-env` before
 * anything that reads `config`.
 */

export type FakeLoki = FakePrometheus;
export type { Answer, SeenRequest };

/** `{ status: "success", data }`, as every Loki query answer is shaped. */
export const lokiSuccess = (data: unknown): Answer => ({
  json: { status: "success", data },
});

export function startFakeLoki(prefix = ""): Promise<FakeLoki> {
  return startFakePrometheus(prefix);
}

/** Wrap a handler so that a non-GET request is answered 405, as Loki answers it. */
export function getOnly(handle: (request: SeenRequest) => Answer) {
  return (request: SeenRequest): Answer =>
    request.method === "GET"
      ? handle(request)
      : { status: 405, text: "method not allowed" };
}
