import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A Prometheus-shaped HTTP endpoint on a loopback port, for the tests of the
 * client, discovery, refresh and the connection test. Each request is
 * recorded, and `handle` decides the answer by path. Import
 * `./prometheus-env` before anything that reads `config`, so the loopback
 * address is in `SOURCE_URL_ALLOWLIST`.
 */

export interface SeenRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  form: URLSearchParams;
  headers: IncomingMessage["headers"];
}

export interface Answer {
  status?: number;
  json?: unknown;
  text?: string;
}

export interface FakePrometheus {
  url: string;
  seen: SeenRequest[];
  handle: (request: SeenRequest) => Answer;
  close: () => Promise<void>;
}

/** `{ status: "success", data }`, as every API answer is shaped. */
export const success = (data: unknown): Answer => ({ json: { status: "success", data } });

export async function startFakePrometheus(prefix = ""): Promise<FakePrometheus> {
  const fake: FakePrometheus = {
    url: "",
    seen: [],
    handle: () => ({ status: 404, json: { status: "error", errorType: "not_found" } }),
    close: async () => {},
  };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const request: SeenRequest = {
        method: req.method ?? "",
        path: url.pathname.slice(prefix.length),
        query: url.searchParams,
        form: new URLSearchParams(body),
        headers: req.headers,
      };
      fake.seen.push(request);
      const answer = fake.handle(request);
      res.writeHead(answer.status ?? 200, {
        "Content-Type": answer.text !== undefined ? "text/plain" : "application/json",
      });
      res.end(answer.text ?? JSON.stringify(answer.json ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${prefix}`;
  fake.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return fake;
}

/** The request's parameters, wherever it carried them: the query or the body. */
export function params(request: SeenRequest): URLSearchParams {
  return request.method === "GET" ? request.query : request.form;
}
