import { createServer } from "node:http";
import { MODEL_ENDPOINT_PORT } from "./env";

/**
 * A model on "this machine" for the end-to-end suite (#607): an endpoint that
 * answers the OpenAI-style `GET /v1/models` the way Ollama does, with one
 * model, so the app's detection has something to find and the Models page's
 * "Detected on this machine" section is on screen for the journeys and the
 * axe scans. It lists models only; nothing in the suite chats with it.
 */
const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: [{ id: "e2e-local", object: "model", owned_by: "library" }],
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

// Every interface, so `localhost` reaches it whether it resolves to ::1 or
// 127.0.0.1 first.
server.listen(MODEL_ENDPOINT_PORT, () => {
  process.stdout.write(`model endpoint listening on ${MODEL_ENDPOINT_PORT}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
