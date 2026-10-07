import {
  addressInAny,
  type Cidr,
  parseAddress,
  parseCidr,
  parseCidrList,
} from "@/lib/cidr";

/**
 * The rules for a model base URL someone typed into the app (#331), as pure
 * functions. A configured base URL means the server makes requests, carrying
 * a credential, to an address a person chose; without these that is a way
 * to reach the cluster's own services, or the cloud metadata endpoint, from
 * inside the network.
 *
 * - `https` only, unless the host is in the operator's allowlist
 *   (`AI_BASE_URL_ALLOWLIST`), e.g. a local Ollama on plain `http`;
 * - no private, loopback, link-local or otherwise non-public address, checked
 *   on every address the name resolves to and again on the address each
 *   connection actually uses (`guarded-fetch.ts`), unless allowlisted;
 * - no credentials in the URL, and redirects are never followed.
 *
 * No Node imports: startup validation reads the allowlist through here, and
 * `src/lib/config.ts` reaches the browser bundle.
 */

/** An operator's allowlist: exact host names, and addresses or CIDR ranges. */
export interface BaseUrlAllowlist {
  hosts: ReadonlySet<string>;
  cidrs: readonly Cidr[];
}

const HOST_NAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** One allowlist entry is a CIDR or address, or a host name. Null when it is neither. */
function parseEntry(entry: string): { host: string } | { cidr: Cidr } | null {
  const cidr = parseCidr(entry);
  if (cidr) return { cidr };
  const host = entry.toLowerCase();
  return HOST_NAME.test(host) ? { host } : null;
}

/** The entries of `AI_BASE_URL_ALLOWLIST` that do not parse; empty when it is valid. */
export function invalidAllowlistEntries(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .filter(Boolean)
    .filter((e) => parseEntry(e) === null);
}

/**
 * Parse `AI_BASE_URL_ALLOWLIST`. An entry that does not parse is dropped, so
 * a typo cannot widen it; `validateConfig` refuses to boot on one anyway.
 */
export function parseBaseUrlAllowlist(raw: string | undefined): BaseUrlAllowlist {
  const hosts = new Set<string>();
  const cidrs: Cidr[] = [];
  for (const entry of (raw ?? "").split(/[,\s]+/).filter(Boolean)) {
    const parsed = parseEntry(entry);
    if (!parsed) continue;
    if ("host" in parsed) hosts.add(parsed.host);
    else cidrs.push(parsed.cidr);
  }
  return { hosts, cidrs };
}

/**
 * Every range that is not the public internet: "this network", RFC 1918,
 * carrier-grade NAT, loopback, link-local (which holds the cloud metadata
 * endpoint), the IETF and documentation blocks, benchmarking, multicast and
 * reserved; and for IPv6 the unspecified and loopback addresses, NAT64 and
 * 6to4 (which embed an IPv4 address), unique-local, link-local, site-local,
 * documentation and multicast. An IPv4-mapped IPv6 address is folded to its
 * IPv4 form by `parseAddress`, so it is held to the IPv4 list.
 */
const NON_PUBLIC = parseCidrList(
  [
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.88.99.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/4",
    "240.0.0.0/4",
    "::/128",
    "::1/128",
    "64:ff9b::/96",
    "64:ff9b:1::/48",
    "100::/64",
    "2001:db8::/32",
    "2002::/16",
    "fc00::/7",
    "fe80::/10",
    "fec0::/10",
    "ff00::/8",
  ].join(","),
);

/** Is `address` anywhere but the public internet? An unparseable one counts as not public. */
export function isNonPublicAddress(address: string): boolean {
  if (!parseAddress(address)) return true;
  return addressInAny(address, NON_PUBLIC);
}

/** The URL's host as the allowlist and the resolver see it: lower case, no IPv6 brackets. */
export function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

/** Is this host allowlisted, by name or (for an address literal) by range? */
export function hostAllowlisted(host: string, allowlist: BaseUrlAllowlist): boolean {
  if (allowlist.hosts.has(host)) return true;
  return parseAddress(host) !== null && addressInAny(host, allowlist.cidrs);
}

/**
 * May a connection for `host` go to `address`? An allowlisted host may reach
 * anything it resolves to, which is the point of allowlisting a local
 * endpoint; otherwise the address must be public or inside an allowlisted
 * range.
 */
export function addressAllowed(
  host: string,
  address: string,
  allowlist: BaseUrlAllowlist,
): boolean {
  if (hostAllowlisted(host, allowlist)) return true;
  if (addressInAny(address, allowlist.cidrs)) return true;
  return !isNonPublicAddress(address);
}

/**
 * What is wrong with a base URL before any name is resolved, or null. The
 * address checks need DNS and are `checkBaseUrl` in `guarded-fetch.ts`.
 */
export function baseUrlShapeProblem(
  raw: string,
  allowlist: BaseUrlAllowlist,
): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "The base URL is not a valid URL.";
  }
  if (url.username || url.password) {
    return "The base URL must not carry a user name or password; put the key in the API key field.";
  }
  const host = hostOf(url);
  if (url.protocol === "http:") {
    if (!hostAllowlisted(host, allowlist)) {
      return `The base URL must use https. Plain http is allowed only for a host in AI_BASE_URL_ALLOWLIST, and ${host} is not in it.`;
    }
  } else if (url.protocol !== "https:") {
    return "The base URL must use https.";
  }
  if (parseAddress(host) && !addressAllowed(host, host, allowlist)) {
    return `The base URL points at ${host}, which is not a public address. Ask an operator to add it to AI_BASE_URL_ALLOWLIST if this server should reach it.`;
  }
  return null;
}
