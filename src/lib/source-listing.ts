import type { SourceRecord } from "@/lib/registry";
import type { LokiListing } from "@/lib/sources/kinds/loki";
import type { PrometheusListing } from "@/lib/sources/kinds/prometheus";
import type { TimescaleDbListing } from "@/lib/sources/kinds/timescaledb";
import { sourceKind } from "@/lib/sources/registry";

export type { LokiListing, PrometheusListing, TimescaleDbListing };

/**
 * What a source looks like to someone who may use it but not manage it.
 *
 * The data sources page is open to viewers read-only (#123), and so is the
 * list route behind it. A full {@link SourceRecord} carries the host, port,
 * database, TLS setting and `secret_ref`, which invariant 5 keeps out of
 * client-visible payloads, and every catalog column, including the ones an
 * admin hid. A viewer needs none of that to see which sources exist and
 * whether they work. This is a named allowlist rather than a spread with
 * deletions, so a field added to `SourceRecord` later does not reach a viewer
 * by default. Each kind declares its own listing, beside its config.
 */
export type SourceListing = TimescaleDbListing | PrometheusListing | LokiListing;

/** What every kind's listing carries. */
export interface ListingBase {
  id: string;
  workspaceId: string;
  name: string;
  tombstonedAt: string | null;
}

/** Projected by the source's kind, which names each field it lets through. */
export function sourceListing(source: SourceRecord): SourceListing {
  return sourceKind(source).listing(source);
}
