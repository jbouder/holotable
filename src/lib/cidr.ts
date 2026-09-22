/**
 * IPv4 and IPv6 address and CIDR parsing.
 *
 * Its own module, with no Node imports, because both the `/api/metrics` gate
 * (`src/lib/metrics-access.ts`) and startup validation (`src/lib/config.ts`)
 * need it, and the latter reaches the browser bundle.
 */

export interface Cidr {
  /** 4 bytes for IPv4, 16 for IPv6. */
  bytes: Uint8Array;
  /** Significant leading bits. */
  prefix: number;
}

/**
 * Parse a comma- or space-separated allowlist. An unparseable entry is dropped
 * rather than thrown: a malformed value must not be able to open the gate, and
 * `validateConfig` already refuses to boot on one.
 */
export function parseCidrList(raw: string): Cidr[] {
  const out: Cidr[] = [];
  for (const entry of raw.split(/[,\s]+/)) {
    const parsed = parseCidr(entry.trim());
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Parse one `address` or `address/bits`. Returns `null` if it is not valid. */
export function parseCidr(entry: string): Cidr | null {
  if (entry.length === 0) return null;
  const slash = entry.lastIndexOf("/");
  const address = slash === -1 ? entry : entry.slice(0, slash);
  const bytes = parseAddress(address);
  if (!bytes) return null;
  const full = bytes.length * 8;
  if (slash === -1) return { bytes, prefix: full };
  const prefix = Number(entry.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > full) return null;
  return { bytes, prefix };
}

/** Is `address` inside any of `cidrs`? An unparseable address matches nothing. */
export function addressInAny(address: string, cidrs: readonly Cidr[]): boolean {
  const bytes = parseAddress(address);
  if (!bytes) return false;
  return cidrs.some((cidr) => inCidr(bytes, cidr));
}

function inCidr(address: Uint8Array, cidr: Cidr): boolean {
  // An IPv4 address and an IPv6 range are different families; `parseAddress`
  // has already folded `::ffff:10.0.0.1` down to its IPv4 form, so a length
  // mismatch here really is a mismatch.
  if (address.length !== cidr.bytes.length) return false;
  const whole = cidr.prefix >> 3;
  for (let i = 0; i < whole; i++) {
    if (address[i] !== cidr.bytes[i]) return false;
  }
  const remainder = cidr.prefix & 7;
  if (remainder === 0) return true;
  const mask = 0xff << (8 - remainder);
  return (address[whole] & mask) === (cidr.bytes[whole] & mask);
}

/**
 * Parse an IPv4 or IPv6 address into its bytes. An IPv4-mapped IPv6 address
 * (`::ffff:10.0.0.1`, which is how a dual-stack listener reports an IPv4 peer)
 * is folded to its 4-byte IPv4 form, so an operator writes `10.0.0.0/8` once
 * and it matches however the address arrived.
 */
export function parseAddress(value: string): Uint8Array | null {
  const address = value.trim();
  if (address.length === 0) return null;
  if (!address.includes(":")) return parseIpv4(address);

  // Drop a zone id (`fe80::1%eth0`); it names an interface, not an address.
  const bare = address.split("%")[0];
  const bytes = parseIpv6(bare);
  if (!bytes) return null;

  const mapped =
    bytes.subarray(0, 10).every((b) => b === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  return mapped ? bytes.subarray(12) : bytes;
}

function parseIpv4(value: string): Uint8Array | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    // Reject leading zeros and non-digits: `010` is not 8, and an octet that
    // parses two ways is an octet an allowlist can be fooled with.
    if (!/^(0|[1-9]\d{0,2})$/.test(parts[i])) return null;
    const octet = Number(parts[i]);
    if (octet > 255) return null;
    out[i] = octet;
  }
  return out;
}

function parseIpv6(value: string): Uint8Array | null {
  const halves = value.split("::");
  if (halves.length > 2) return null;

  const expand = (part: string): number[][] | null => {
    if (part.length === 0) return [];
    const groups: number[][] = [];
    const pieces = part.split(":");
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      // A trailing IPv4 form (`::ffff:10.0.0.1`) stands for the last two groups.
      if (piece.includes(".")) {
        if (i !== pieces.length - 1) return null;
        const v4 = parseIpv4(piece);
        if (!v4) return null;
        groups.push([v4[0], v4[1]], [v4[2], v4[3]]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      const group = Number.parseInt(piece, 16);
      groups.push([group >> 8, group & 0xff]);
    }
    return groups;
  };

  const head = expand(halves[0]);
  const tail = halves.length === 2 ? expand(halves[1]) : [];
  if (!head || !tail) return null;

  if (halves.length === 1) {
    if (head.length !== 8) return null;
    return new Uint8Array(head.flat());
  }
  const gap = 8 - head.length - tail.length;
  // `::` must stand for at least one group, or it is just a stray colon pair.
  if (gap < 1) return null;
  const middle: number[][] = Array.from({ length: gap }, () => [0, 0]);
  return new Uint8Array([...head, ...middle, ...tail].flat());
}
