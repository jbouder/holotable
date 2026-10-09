import { type LookupAddress, type LookupAllOptions, lookup as dnsLookup } from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";
import {
  addressAllowed,
  type BaseUrlAllowlist,
  baseUrlShapeProblem,
  hostOf,
} from "@/lib/ai/base-url";

/**
 * The network half of the base-URL guard (#331): the checks in `base-url.ts`
 * applied to what DNS says, at save time and on every connection.
 *
 * Checking the resolved addresses once, when the URL is saved, is not enough:
 * a name can resolve to a public address while it is checked and to
 * `169.254.169.254` a minute later (DNS rebinding). So the requests a
 * configured model makes go through an undici `Agent` whose `lookup` refuses
 * a non-public address for the connection it is about to open; there is no
 * window between the check and the connect. An address literal is never
 * looked up, so the shape check runs on every request too.
 */

/** The base URL, or a request to it, was refused by the guard. */
export class BaseUrlRefusedError extends Error {
  override name = "BaseUrlRefusedError";
}

/**
 * The refusal behind a failed model call, or null. A refused connection
 * reaches the caller wrapped: undici turns the lookup's error into a
 * `TypeError("fetch failed")` and the SDK into an `APICallError`, each with
 * the one before as its `cause`.
 */
export function baseUrlRefusal(error: unknown): BaseUrlRefusedError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth++) {
    if (current instanceof BaseUrlRefusedError) return current;
    current = current instanceof Error ? current.cause : undefined;
  }
  return null;
}

type Resolve = (
  hostname: string,
  options: LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** What a connection's `lookup` is: Node's signature, `all` or not. */
export type GuardedLookup = (
  hostname: string,
  options: { all?: boolean; family?: number | string },
  callback: LookupCallback,
) => void;

function refused(host: string, address: string, variable: string): BaseUrlRefusedError {
  return new BaseUrlRefusedError(
    `${host} resolves to ${address}, which is not a public address. Ask an operator to add it to ${variable} if this server should reach it.`,
  );
}

/**
 * A `lookup` for outbound connections that resolves every address and
 * refuses the connection when any of them is not allowed, so a name with one
 * public and one private record cannot be steered to the private one.
 */
export function guardedLookup(
  allowlist: BaseUrlAllowlist,
  resolve: Resolve = dnsLookup as unknown as Resolve,
): GuardedLookup {
  return (hostname, options, callback) => {
    const family = options.family === 4 || options.family === 6 ? options.family : 0;
    resolve(hostname, { family, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const host = hostname.toLowerCase();
      if (addresses.length === 0) {
        return callback(new BaseUrlRefusedError(`${host} did not resolve.`), []);
      }
      const bad = addresses.find((a) => !addressAllowed(host, a.address, allowlist));
      if (bad) return callback(refused(host, bad.address, allowlist.variable), []);
      if (options.all) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

/**
 * What is wrong with a base URL, DNS included, or null. Run when it is saved
 * and before a connection test; the per-connection check is
 * {@link guardedLookup}.
 */
export async function checkBaseUrl(
  raw: string,
  allowlist: BaseUrlAllowlist,
  resolve: Resolve = dnsLookup as unknown as Resolve,
): Promise<string | null> {
  const shape = baseUrlShapeProblem(raw, allowlist);
  if (shape) return shape;
  const host = hostOf(new URL(raw));
  return new Promise((done) => {
    guardedLookup(allowlist, resolve)(host, { all: true }, (err) => {
      if (!err) return done(null);
      done(
        err instanceof BaseUrlRefusedError
          ? err.message
          : `${host} could not be resolved (${err.code ?? "lookup failed"}).`,
      );
    });
  });
}

/** One connection pool per allowlist, since its `lookup` closes over it. */
const agents = new WeakMap<BaseUrlAllowlist, Agent>();

function agentFor(allowlist: BaseUrlAllowlist): Agent {
  let agent = agents.get(allowlist);
  if (!agent) {
    agent = new Agent({ connect: { lookup: guardedLookup(allowlist) } });
    agents.set(allowlist, agent);
  }
  return agent;
}

/**
 * The `fetch` a configured model is given. It reaches the configured origin
 * and nothing else, connects only to allowed addresses, and does not follow a
 * redirect: one would be a way to send the key's request somewhere else.
 */
export function guardedFetch(baseUrl: string, allowlist: BaseUrlAllowlist): typeof fetch {
  const origin = new URL(baseUrl).origin;
  const guarded = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.origin !== origin) {
      throw new BaseUrlRefusedError(
        `A request asked for ${url.origin}, not the configured ${origin}.`,
      );
    }
    // The allowlist can change under a stored URL, and an address literal
    // never reaches the lookup.
    const problem = baseUrlShapeProblem(url.href, allowlist);
    if (problem) throw new BaseUrlRefusedError(problem);
    const response = await undiciFetch(url, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      redirect: "manual",
      dispatcher: agentFor(allowlist),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new BaseUrlRefusedError(
        `The endpoint answered with a redirect (${response.status}), which is not followed. Use the URL it redirects to as the ${allowlist.noun}.`,
      );
    }
    return response as unknown as Response;
  };
  return guarded as typeof fetch;
}
