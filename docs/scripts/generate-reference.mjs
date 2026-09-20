/**
 * Generate reference pages from the application source.
 *
 * The configuration table is derived from `src/lib/config.ts` and the
 * visualization list from `VizType` in `src/lib/ir.ts`, so neither can drift
 * from the code the way a hand-maintained list does. Run by `npm run build`
 * and `npm run dev`; the output files are gitignored.
 *
 * This script FAILS LOUDLY. If the shape of the source changes so that a value
 * can no longer be extracted, the docs build breaks rather than silently
 * publishing a stale or empty reference.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const outDir = join(here, "..", "src", "content", "docs", "reference");

const read = (rel) => readFileSync(join(repoRoot, rel), "utf8");

function fail(message) {
  console.error(`\n  generate-reference: ${message}\n`);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* Configuration, from src/lib/config.ts                                      */
/* -------------------------------------------------------------------------- */

function parseConfig() {
  const source = read("src/lib/config.ts");
  const start = source.indexOf("export const config = {");
  const end = source.indexOf("} as const;", start);
  if (start === -1 || end === -1) {
    fail("could not locate `export const config = { ... } as const;` in src/lib/config.ts");
  }
  const body = source.slice(source.indexOf("{", start) + 1, end);

  const entries = [];
  let comment = [];

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("/**") || line.startsWith("*") || line.startsWith("*/")) {
      const text = line
        .replace(/^\/\*\*/, "")
        .replace(/\*\/$/, "")
        .replace(/^\*/, "")
        .trim();
      if (text) comment.push(text);
      continue;
    }

    // key: num("ENV_NAME", 1_000)  |  key: str("ENV_NAME", "default")  |  key: bool("ENV_NAME", false)
    const m = line.match(/^(\w+):\s*(num|str|bool)\(\s*"([A-Z0-9_]+)"\s*,\s*(.+?)\s*\),?$/);
    if (m) {
      const [, key, kind, env, rawDefault] = m;
      entries.push({
        key,
        env,
        type: { num: "number", str: "string", bool: "boolean" }[kind],
        // Numeric literals may carry `_` separators (15_000); string
        // defaults must keep any underscores they contain.
        default:
          kind === "num"
            ? rawDefault.replace(/_/g, "")
            : rawDefault.replace(/^"(.*)"$/, "$1"),
        description: comment.join(" ").replace(/\s+/g, " ").trim(),
      });
      comment = [];
      continue;
    }

    // Any other assignment (e.g. isProduction) resets the pending comment.
    if (line.includes(":")) comment = [];
  }

  if (entries.length === 0) fail("parsed zero configuration entries from src/lib/config.ts");
  return entries;
}

/* -------------------------------------------------------------------------- */
/* Enums, from src/lib/ir.ts                                                  */
/* -------------------------------------------------------------------------- */

function parseEnum(source, name) {
  const re = new RegExp(`export const ${name} = z\\.enum\\(\\[([\\s\\S]*?)\\]\\)`);
  const m = source.match(re);
  if (!m) fail(`could not locate \`export const ${name} = z.enum([...])\` in src/lib/ir.ts`);
  const values = [...m[1].matchAll(/"([^"]+)"/g)].map((v) => v[1]);
  if (values.length === 0) fail(`parsed zero values from ${name}`);
  return values;
}

/* -------------------------------------------------------------------------- */

const config = parseConfig();
const ir = read("src/lib/ir.ts");
const vizTypes = parseEnum(ir, "VizType");
const valueFormats = parseEnum(ir, "ValueFormat");

const banner = (sourceFile) =>
  `---\n` +
  `title: TITLE\n` +
  `description: DESCRIPTION\n` +
  `---\n\n` +
  `{/* GENERATED FILE — do not edit. Produced by docs/scripts/generate-reference.mjs from ${sourceFile}. */}\n`;

/* ---- reference/configuration.md ---- */

const configRows = config
  .map((e) => `| \`${e.env}\` | ${e.type} | \`${e.default === "" ? "—" : e.default}\` | ${e.description || "—"} |`)
  .join("\n");

const configPage =
  banner("`src/lib/config.ts`")
    .replace("TITLE", "Configuration")
    .replace(
      "DESCRIPTION",
      "Every environment variable read by src/lib/config.ts, with its type and documented default.",
    ) +
  `
All tunable behaviour is environment-driven and centralized in
[\`src/lib/config.ts\`](https://github.com/jbouder/holotable/blob/main/src/lib/config.ts).
This table is generated from that file, so it cannot drift from the code.
Every variable below and in the next table is validated at server startup;
[Startup validation](/operations/startup-validation/) lists which are required
in production and what \`npm run config:check\` reports.

| Variable | Type | Default | Purpose |
| --- | --- | --- | --- |
${configRows}

## Variables read outside \`config.ts\`

These are read directly from \`process.env\` at their point of use rather than
through the config module.

| Variable | Read by | Purpose |
| --- | --- | --- |
| \`DATABASE_URL\` | \`src/lib/db/pg.ts\` | Config-store connection string. Required. |
| \`PG_POOL_MAX\` | \`src/lib/db/pg.ts\` | Config-store pool size. Defaults to \`10\`. |
| \`SESSION_SECRET\` | \`src/lib/auth/session.ts\` | HS256 signing key for first-party session tokens. Must be at least 32 characters in production. |
| \`AI_PROVIDER\` | \`src/lib/ai/provider.ts\` | \`gateway\` or \`openai-compatible\`. |
| \`OPENAI_BASE_URL\`, \`OPENAI_API_KEY\`, \`OPENAI_API\` | \`src/lib/ai/provider.ts\` | OpenAI-compatible endpoint selection. See [AI provider](/operations/ai-provider/). |
| \`AI_GATEWAY_API_KEY\` | AI SDK | Used when \`AI_PROVIDER=gateway\`. |
| \`OIDC_ISSUER\`, \`OIDC_CLIENT_ID\`, \`OIDC_CLIENT_SECRET\`, \`OIDC_REDIRECT_URI\`, \`OIDC_SCOPE\` | \`src/lib/auth/oidc.ts\` | OIDC login flow. See [Keycloak setup](/operations/keycloak/). |
| \`OIDC_JWKS_URL\`, \`OIDC_AUDIENCE\`, \`OIDC_GROUPS_CLAIM\` | \`src/lib/auth/session.ts\` | Token verification and the group claim name. |
| \`<SECRET_REF>_USERNAME\` / \`<SECRET_REF>_PASSWORD\` | \`src/lib/registry.ts\` | Per-source credentials resolved at execution time. See [Source secret references](/operations/secret-references/). |
`;

/* ---- reference/visualization-types.md ---- */

const VIZ_NOTES = {
  line: "Time series as a continuous line. Requires `query.timeField`.",
  area: "Filled time series. Requires `query.timeField`.",
  bar: "Bars over time or across a categorical dimension.",
  scatter: "Relationship between two numeric dimensions.",
  stat: "A single scalar value, formatted per `panel.format`. Omits `query.timeField`.",
  table: "The result rows as an HTML table.",
  heatmap: "Two dimensions against a numeric intensity.",
  pie: "Proportional breakdown across a small set of categories. Omits `query.timeField`.",
  donut: "A pie with an inner radius. Omits `query.timeField`.",
};

const vizRows = vizTypes
  .map((v) => `| \`${v}\` | ${VIZ_NOTES[v] ?? "—"} |`)
  .join("\n");

const formatRows = valueFormats
  .map((f) => `| \`${f}\` |`)
  .join("\n");

const vizPage =
  banner("`VizType` and `ValueFormat` in `src/lib/ir.ts`")
    .replace("TITLE", "Visualization types")
    .replace("DESCRIPTION", "The panel visualization kinds and value formats defined by the shared IR.")
  + `
A panel's \`viz\` field selects its renderer. This list is generated from
\`VizType\` in [\`src/lib/ir.ts\`](https://github.com/jbouder/holotable/blob/main/src/lib/ir.ts),
which is the single definition shared by the model's output schema, the API,
persistence, and the client.

## \`viz\`

| Value | Notes |
| --- | --- |
${vizRows}

\`stat\` and \`table\` are rendered as HTML by \`PanelView\`; every other kind is
built into an ECharts option by \`buildChartOption\` in
\`src/components/charts/options.ts\`.

## \`format\`

\`panel.format\` controls how numeric values are rendered by \`formatValue\`
(\`src/lib/format.ts\`). It is optional.

| Value |
| --- |
${formatRows}
`;

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "configuration.md"), configPage);
writeFileSync(join(outDir, "visualization-types.md"), vizPage);

console.log(
  `generate-reference: ${config.length} config variables, ` +
    `${vizTypes.length} viz types, ${valueFormats.length} value formats`,
);
