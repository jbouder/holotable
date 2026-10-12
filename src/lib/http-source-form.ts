import { type ApiError, apiErrorFromThrown, readApiError } from "@/lib/errors";
import type { HttpSourceAuth } from "@/lib/sources/http-config";
import type { z } from "zod";

/**
 * What the forms of the HTTP kinds (Prometheus, Loki) share: the auth modes,
 * the `secret_ref` rule, and the one fetch helper that asks
 * `POST /api/sources/discover` about an endpoint that has no source yet. The
 * route checks everything it is sent; this only shapes the body and reads the
 * answer.
 */

export type HttpAuth = z.infer<typeof HttpSourceAuth>;

/** Whether this auth mode names a `secret_ref`: every mode but `none`. */
export function needsSecretRef(auth: HttpAuth): boolean {
  return auth !== "none";
}

export interface HttpDiscoveryInput {
  workspaceId: string;
  url: string;
  auth: HttpAuth;
  secretRef: string | null;
}

export type Discovered<T> = { ok: true; value: T } | { ok: false; error: ApiError };

/**
 * Ask the discover route about a drafted endpoint of `kind`, with `extra`
 * naming what to ask, and `pick` the part of the answer wanted.
 */
export async function discoverFromEndpoint<T>(
  kind: string,
  input: HttpDiscoveryInput,
  extra: Record<string, unknown>,
  pick: (body: Record<string, unknown>) => T,
): Promise<Discovered<T>> {
  try {
    const res = await fetch("/api/sources/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind,
        workspaceId: input.workspaceId,
        url: input.url,
        auth: input.auth,
        ...(input.secretRef ? { secretRef: input.secretRef } : {}),
        ...extra,
      }),
    });
    if (!res.ok) return { ok: false, error: await readApiError(res) };
    const answer = (await res.json()) as Record<string, unknown>;
    if (answer.ok !== true) {
      return {
        ok: false,
        error: { error: String(answer.error ?? "Discovery failed."), kind: "validation" },
      };
    }
    return { ok: true, value: pick(answer) };
  } catch (err) {
    return { ok: false, error: apiErrorFromThrown(err) };
  }
}
