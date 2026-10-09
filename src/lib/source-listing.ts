import type { SourceRecord } from "@/lib/registry";
import { sourceKind } from "@/lib/sources/registry";

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
 * by default.
 */
export type SourceListing = TimescaleDbListing | PrometheusListing;

interface ListingBase {
  id: string;
  workspaceId: string;
  name: string;
  tombstonedAt: string | null;
}

export interface TimescaleDbListing extends ListingBase {
  kind: "timescaledb";
  schema: string;
  tableCount: number;
}

/** A Prometheus source (#385): never its URL or its auth mode. */
export interface PrometheusListing extends ListingBase {
  kind: "prometheus";
  metricCount: number;
}

/** Projected by the source's kind, which names each field it lets through. */
export function sourceListing(source: SourceRecord): SourceListing {
  return sourceKind(source).listing(source);
}
