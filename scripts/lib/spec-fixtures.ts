import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CatalogTable, RowFilter } from "@/lib/registry";

/**
 * The IR fixture library (#90): dashboard specs as they were stored, one file
 * each, under `test/fixtures/specs/`.
 *
 * Shared by `scripts/capture-spec-fixture.ts`, which adds to it, and
 * `test/ir-contract.test.ts`, which holds every build to it, so the two read
 * the directory the same way. Nothing in the app imports it.
 *
 * The rules the directory keeps:
 *
 * - **A fixture is a spec exactly as it was saved.** No envelope, no comments:
 *   it is the `dashboard_versions.spec` jsonb, and the test reads it the way
 *   the app reads that column, through `StoredDashboard`.
 * - **A fixture is never edited.** `index.json` records each one's version and
 *   a digest of its content, and the contract test fails on a mismatch. A
 *   breaking IR change keeps every existing fixture loading through an
 *   upgrader, and adds fixtures of the new version beside them.
 * - **The catalogs are part of the fixture.** `catalogs.json` holds, per
 *   `sourceId`, the allowlist a fixture's SQL is validated against: schema,
 *   tables and row filter, never a host or a credential. Entries are added,
 *   never changed; a capture whose source disagrees with the recorded catalog
 *   is refused.
 */

/** Where the library lives, resolved from this module. */
export const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "fixtures",
  "specs",
);

export const MANIFEST_FILE = "index.json";
export const CATALOGS_FILE = "catalogs.json";

/** What a fixture's SQL is validated against: a source minus its connection. */
export const FixtureCatalog = z
  .object({
    schema: z.string().min(1),
    tables: z.array(CatalogTable).min(1),
    rowFilter: RowFilter.optional(),
  })
  .strict();
export type FixtureCatalog = z.infer<typeof FixtureCatalog>;

export const FixtureEntry = z
  .object({
    /** The `specVersion` the spec was saved at; 1 for one that has none. */
    authoredAt: z.number().int().min(1),
    /** {@link contentDigest} of the file when it was added. */
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    /** Where it came from: written by hand for a case, or captured from a row. */
    origin: z.string().min(1),
  })
  .strict();
export type FixtureEntry = z.infer<typeof FixtureEntry>;

export const Manifest = z.record(z.string(), FixtureEntry);
export type Manifest = z.infer<typeof Manifest>;

export const Catalogs = z.record(z.string(), FixtureCatalog);
export type Catalogs = z.infer<typeof Catalogs>;

/**
 * A digest of a fixture's content, not its bytes: the formatter may rewrap a
 * file without changing what it says, and that is not an edit.
 */
export function contentDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** The version a stored spec was saved at. A spec without one is version 1. */
export function authoredVersion(spec: unknown): number {
  const v = (spec as { specVersion?: unknown } | null)?.specVersion;
  return typeof v === "number" ? v : 1;
}

/** `v<version>-<slug>.json`, the one naming scheme the directory uses. */
export function fixtureFileName(version: number, slug: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(`fixture name "${slug}" must be lowercase words joined by "-"`);
  }
  return `v${version}-${slug}.json`;
}

export interface Fixture {
  file: string;
  /** The parsed file: the spec as stored, not yet upgraded. */
  spec: unknown;
}

export interface FixtureLibrary {
  manifest: Manifest;
  catalogs: Catalogs;
  fixtures: Fixture[];
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function isFixtureFile(name: string): boolean {
  return name.endsWith(".json") && name !== MANIFEST_FILE && name !== CATALOGS_FILE;
}

/** Read the whole library: every fixture file, the manifest and the catalogs. */
export function loadFixtureLibrary(dir: string = FIXTURES_DIR): FixtureLibrary {
  const manifest = Manifest.parse(readJson(join(dir, MANIFEST_FILE)));
  const catalogs = Catalogs.parse(readJson(join(dir, CATALOGS_FILE)));
  const fixtures = readdirSync(dir)
    .filter(isFixtureFile)
    .sort()
    .map((file) => ({ file, spec: readJson(join(dir, file)) }));
  return { manifest, catalogs, fixtures };
}

/** Write JSON the way the formatter leaves it closest to: two-space indent. */
function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Add one fixture, with the catalogs its SQL needs, to the library.
 *
 * Refuses a file that exists (fixtures are never edited) and a catalog that
 * disagrees with the one already recorded under that source id (catalogs are
 * never edited either; capture it under a new id instead). Returns the path
 * written.
 */
export function addFixture(input: {
  dir?: string;
  slug: string;
  spec: unknown;
  catalogs: Catalogs;
  origin: string;
}): string {
  const dir = input.dir ?? FIXTURES_DIR;
  const version = authoredVersion(input.spec);
  const file = fixtureFileName(version, input.slug);
  const path = join(dir, file);
  if (existsSync(path)) {
    throw new Error(`${file} exists; fixtures are never edited, pick another name`);
  }

  const library = loadFixtureLibrary(dir);
  const catalogs = { ...library.catalogs };
  for (const [id, catalog] of Object.entries(input.catalogs)) {
    const recorded = catalogs[id];
    if (recorded && contentDigest(recorded) !== contentDigest(catalog)) {
      throw new Error(
        `catalogs.json already records a different catalog for source "${id}"; ` +
          `catalogs are never edited. Re-point the captured spec at a new source id ` +
          `with --source ${id}=<new-id>.`,
      );
    }
    catalogs[id] = catalog;
  }

  writeJson(path, input.spec);
  writeJson(join(dir, CATALOGS_FILE), catalogs);
  writeJson(join(dir, MANIFEST_FILE), {
    ...library.manifest,
    [file]: {
      authoredAt: version,
      digest: contentDigest(input.spec),
      origin: input.origin,
    },
  });
  return path;
}
