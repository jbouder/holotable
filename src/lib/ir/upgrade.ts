import { z } from "zod";
import { Dashboard } from "@/lib/ir";

/**
 * The upgrader chain for stored dashboard specs (#58).
 *
 * `Dashboard` accepts exactly one `specVersion`, the current one. A spec this
 * build did not just produce may be older: a `dashboard_versions` row, a saved
 * template, an export file, a browser draft, or a save from a tab that was
 * opened before the deploy. All of those are read through
 * {@link StoredDashboard}, which brings the spec up to the current version and
 * only then validates it.
 *
 * The rules a new version follows:
 *
 * - **A missing `specVersion` is version 1.** Every spec saved before the field
 *   existed is in the version-1 shape, so that is not a guess.
 * - **An upgrader is a small pure function from version N to N+1**, appended
 *   to {@link UPGRADERS}, with a test that feeds it a version-N fixture. It
 *   works on plain JSON and imports nothing from `ir.ts`: the schemas there
 *   describe the current version only, never the one it is reading. The chain
 *   stamps `specVersion` after each step, so an upgrader does not.
 * - **Reads upgrade in memory and never write back.** `dashboard_versions` rows
 *   are immutable (invariant 3): the stored jsonb keeps the version it was saved
 *   at, and the next save writes the current one. A backfill, if one is ever
 *   wanted, is an offline script, not a side effect of viewing a dashboard.
 * - **A spec from a newer build is refused, not guessed at.** During a rolling
 *   update the old pods can read what the new ones wrote; they say so rather
 *   than misread it.
 */

/** A spec as JSON, before it has been validated against any version's schema. */
export type SpecJson = Record<string, unknown>;

/** Takes a spec of version N (`UPGRADERS[N - 1]`) to version N + 1. */
export type Upgrader = (spec: SpecJson) => SpecJson;

/**
 * `UPGRADERS[i]` takes version `i + 1` to version `i + 2`, so the chain is
 * always `SPEC_VERSION - 1` long; `test/ir.test.ts` holds it to that.
 * Empty while version 1 is the only one there has been.
 */
export const UPGRADERS: readonly Upgrader[] = [];

export type MigrateResult = { ok: true; spec: SpecJson } | { ok: false; error: string };

function isObject(value: unknown): value is SpecJson {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Bring a spec of any supported version up to the newest one the chain
 * reaches, without validating the result. Pure: the input is copied first, so
 * neither it nor anything it was read from is ever modified.
 *
 * `upgraders` is a parameter so the tests can run a chain longer than the one
 * this build ships; everything else uses the default.
 */
export function migrateSpec(
  input: unknown,
  upgraders: readonly Upgrader[] = UPGRADERS,
): MigrateResult {
  if (!isObject(input)) return { ok: false, error: "a dashboard spec must be an object" };
  const target = upgraders.length + 1;
  // Only an absent version is version 1; `null` is not a version at all.
  const version = input.specVersion === undefined ? 1 : input.specVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return { ok: false, error: "specVersion must be a positive integer" };
  }
  if (version > target) {
    return {
      ok: false,
      error: `this spec was saved by a newer version of Holotable (specVersion ${version}); this server reads up to ${target}`,
    };
  }
  let spec: SpecJson = { ...structuredClone(input), specVersion: version };
  for (let from = version; from < target; from++) {
    spec = { ...upgraders[from - 1](spec), specVersion: from + 1 };
  }
  return { ok: true, spec };
}

/**
 * A dashboard spec of any supported version, upgraded and then validated as
 * the current `Dashboard`. The output type is `Dashboard`; a failure to
 * upgrade is an ordinary validation issue, so `safeParse` and a containing
 * schema report it like any other.
 */
export const StoredDashboard = z.preprocess((input, ctx) => {
  const migrated = migrateSpec(input);
  if (migrated.ok) return migrated.spec;
  ctx.addIssue({ code: "custom", message: migrated.error });
  return z.NEVER;
}, Dashboard);

/** Upgrade and validate a stored spec. Throws on one that cannot be read. */
export function upgradeSpec(input: unknown): Dashboard {
  return StoredDashboard.parse(input);
}

/**
 * A lone panel saved at `version`, upgraded the same way.
 *
 * A panel template stores a panel without its dashboard, so it is carried
 * through the dashboard chain inside a minimal one-panel dashboard and taken
 * back out. An upgrader that needs a dashboard-level field to rewrite a panel
 * gets this placeholder's, which is why a panel template also records the
 * version it was saved at rather than relying on its context.
 */
export function migratePanel(
  panel: unknown,
  version: unknown,
  upgraders: readonly Upgrader[] = UPGRADERS,
): MigrateResult {
  const migrated = migrateSpec(
    {
      specVersion: version,
      title: "panel template",
      timeRange: { from: "now-1h", to: "now" },
      refreshIntervalMs: 30_000,
      panels: [panel],
    },
    upgraders,
  );
  if (!migrated.ok) return migrated;
  const panels = migrated.spec.panels;
  if (!Array.isArray(panels) || panels.length !== 1 || !isObject(panels[0])) {
    return { ok: false, error: "an upgrader did not return the panel it was given" };
  }
  return { ok: true, spec: panels[0] };
}
