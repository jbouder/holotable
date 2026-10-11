/**
 * Listing a vendor's models (#443): the shared half of each kind's
 * `listModels`. A reply is untrusted: it is read under a byte cap as it
 * arrives, parsed as JSON, and reduced to ids and display names, each
 * bounded, before anything leaves this module. A failure is a sentence that
 * names the status, never the provider's body, which may echo the key.
 */

/** The most a model list may weigh. OpenRouter's, the largest seen, is about 1.5 MB. */
export const MAX_MODEL_LIST_BYTES = 4 * 1024 * 1024;

/** The most models a list returns; a vendor offering more is truncated. */
export const MAX_LISTED_MODELS = 2_000;

export type { DiscoveredModel } from "@/lib/ai/model-config";
import type { DiscoveredModel } from "@/lib/ai/model-config";

/** Listing failed; `message` is safe to show. */
export class ModelListError extends Error {
  override name = "ModelListError";
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MiB` : `${bytes} bytes`;
}

/** Read a body, stopping as soon as it passes `maxBytes`. */
export async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ModelListError(
        `The provider's model list is larger than ${formatBytes(maxBytes)}; type the model id instead.`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** GET a JSON list through the kind's fetch, under the cap. */
export async function fetchModelList(
  fetch: typeof globalThis.fetch,
  url: string,
  headers: Record<string, string>,
  maxBytes: number = MAX_MODEL_LIST_BYTES,
): Promise<unknown> {
  const response = await fetch(url, { method: "GET", headers });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ModelListError(
      response.status === 401 || response.status === 403
        ? `The provider refused the credentials (${response.status}).`
        : `The provider answered ${response.status} to the model list.`,
    );
  }
  const text = await readCapped(response, maxBytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ModelListError("The provider's model list is not JSON.");
  }
}

const bounded = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : undefined;

/**
 * Entries as discovered models: an id of at most 200 characters, a name of
 * at most 200, duplicates and anything else dropped, sorted by id.
 */
export function toDiscovered(
  entries: unknown,
  pick: (entry: Record<string, unknown>) => { id: unknown; name?: unknown } | null,
): DiscoveredModel[] {
  if (!Array.isArray(entries)) {
    throw new ModelListError("The provider's model list is not in the shape expected.");
  }
  const seen = new Map<string, DiscoveredModel>();
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const picked = pick(entry as Record<string, unknown>);
    const id = bounded(picked?.id, 200);
    if (!id || seen.has(id)) continue;
    const name = bounded(picked?.name, 200);
    seen.set(id, name && name !== id ? { id, name } : { id });
    if (seen.size >= MAX_LISTED_MODELS) break;
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** The OpenAI-protocol `GET /models` shape: `{ data: [{ id }] }`. */
export async function listOpenAiStyle(
  fetch: typeof globalThis.fetch,
  baseUrl: string,
  apiKey: string | undefined,
): Promise<DiscoveredModel[]> {
  const json = await fetchModelList(
    fetch,
    `${baseUrl.replace(/\/+$/, "")}/models`,
    apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  );
  return toDiscovered((json as { data?: unknown })?.data, (e) => ({
    id: e.id,
    name: e.name,
  }));
}

/**
 * A fetch whose replies are read under the cap before an SDK sees them, for
 * a kind that lists through its SDK (the AI Gateway's `getAvailableModels`).
 */
export function cappedFetch(
  fetch: typeof globalThis.fetch,
  maxBytes: number = MAX_MODEL_LIST_BYTES,
): typeof globalThis.fetch {
  const capped = async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fetch(input, init);
    const text = await readCapped(response, maxBytes);
    return new Response(text, { status: response.status, headers: response.headers });
  };
  return capped as typeof globalThis.fetch;
}
