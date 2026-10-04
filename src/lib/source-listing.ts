import type { SourceRecord } from "@/lib/registry";

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
export interface SourceListing {
  id: string;
  workspaceId: string;
  name: string;
  schema: string;
  tableCount: number;
  tombstonedAt: string | null;
}

export function sourceListing(source: SourceRecord): SourceListing {
  return {
    id: source.id,
    workspaceId: source.workspaceId,
    name: source.name,
    schema: source.config.schema,
    tableCount: source.config.tables.length,
    tombstonedAt: source.tombstonedAt,
  };
}
