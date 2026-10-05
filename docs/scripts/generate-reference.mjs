/**
 * Generate reference pages from the application source.
 *
 * The configuration table is derived from `src/lib/config.ts` and the
 * visualization list from the panel registry in `src/lib/panels/`, so neither
 * can drift
 * from the code the way a hand-maintained list does. Run by `npm run build`
 * and `npm run dev`; the output files are gitignored.
 *
 * This script FAILS LOUDLY. If the shape of the source changes so that a value
 * can no longer be extracted, the docs build breaks rather than silently
 * publishing a stale or empty reference.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
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
/* Panel kinds, from src/lib/panels/                                          */
/* -------------------------------------------------------------------------- */

/**
 * The registered kinds, in registry order, each with its `summary`. Every
 * `export const x = definePanelKind({ kind: "...", summary: "..." })` under
 * `src/lib/panels/kinds/` is read, and `PANEL_KINDS` in the registry says
 * which of them are registered and in what order.
 */
function parsePanelKinds() {
  // Either quote style: the formatter switches to single quotes for a
  // string that contains double ones.
  const string = String.raw`(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')`;
  const declared = new Map();
  const kindsDir = "src/lib/panels/kinds";
  for (const file of readdirSync(join(repoRoot, kindsDir))) {
    if (!file.endsWith(".ts")) continue;
    const source = read(`${kindsDir}/${file}`);
    const re = new RegExp(
      String.raw`export const (\w+) = definePanelKind\(\{\s*kind:\s*${string},\s*summary:\s*${string}`,
      "g",
    );
    for (const m of source.matchAll(re)) {
      const kind = m[2] ?? m[3];
      const summary = (m[4] ?? m[5]).replace(/\\(["'])/g, "$1");
      declared.set(m[1], { kind, summary });
    }
  }
  const registry = read("src/lib/panels/registry.ts");
  const list = registry.match(/export const PANEL_KINDS = \[([\s\S]*?)\]/);
  if (!list) fail("could not locate `export const PANEL_KINDS = [...]` in src/lib/panels/registry.ts");
  const names = list[1].split(",").map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) fail("parsed zero panel kinds from PANEL_KINDS");
  return names.map((name) => {
    const kind = declared.get(name);
    if (!kind) {
      fail(
        `PANEL_KINDS lists \`${name}\`, but no \`export const ${name} = definePanelKind({ kind, summary, ... })\` was found in ${kindsDir}/ (kind and summary must come first, as string literals)`,
      );
    }
    return kind;
  });
}

/* -------------------------------------------------------------------------- */

const config = parseConfig();
const ir = read("src/lib/ir.ts");
const panelKinds = parsePanelKinds();
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
| \`SOURCE_SECRET_REFS\` | \`src/lib/secrets/credentials.ts\` | Which workspaces may use which \`secret_ref\`: \`REF:ws1,ws2; OTHER:*\`. Unset grants nothing (an error in production). See [Source secret references](/operations/secret-references/). |
| \`SOURCE_SECRETS_DIR\` | \`src/lib/secrets/credentials.ts\` | Directory of \`<SECRET_REF>_USERNAME\` / \`<SECRET_REF>_PASSWORD\` files, read on every connection before the environment. Optional. |
| \`<SECRET_REF>_USERNAME\` / \`<SECRET_REF>_PASSWORD\` | \`src/lib/secrets/credentials.ts\` | Per-source credentials resolved at execution time. See [Source secret references](/operations/secret-references/). |
| \`APP_VERSION\`, \`GIT_COMMIT\` | \`src/lib/version.ts\` | Build identity reported by \`GET /api/health\`. Optional. See [Health and readiness](/operations/health-checks/). |
| \`METRICS_TOKEN\`, \`METRICS_ALLOWED_CIDRS\` | \`src/lib/metrics-access.ts\` | Who may scrape \`GET /api/metrics\`. Unset on both closes the endpoint. Read outside \`config.ts\` because that module reaches the browser bundle. See [Prometheus metrics](/operations/metrics/). |
`;

/* ---- reference/visualization-types.md ---- */

const vizRows = panelKinds
  .map(({ kind, summary }) => `| \`${kind}\` | ${summary} |`)
  .join("\n");

const formatRows = valueFormats
  .map((f) => `| \`${f}\` |`)
  .join("\n");

const vizPage =
  banner("the panel registry in `src/lib/panels/` and `ValueFormat` in `src/lib/ir.ts`")
    .replace("TITLE", "Visualization types")
    .replace("DESCRIPTION", "The panel visualization kinds and value formats defined by the shared IR.")
  + `
A panel's \`viz\` field selects its kind. This list is generated from the
panel registry,
[\`src/lib/panels/registry.ts\`](https://github.com/jbouder/holotable/blob/main/src/lib/panels/registry.ts),
which \`VizType\` in \`src/lib/ir.ts\` is built from: the same list is the
model's output schema, the generation prompt's choices, the API's validation,
and the client's renderers.

## \`viz\`

| Value | Notes |
| --- | --- |
${vizRows}

\`stat\`, \`table\` and \`text\` are drawn as HTML; every other kind is an
ECharts chart. The options a kind takes are in
[Panel options](/reference/panel-options/), and
[Adding a panel kind](/concepts/streaming-and-rendering/#panel-kinds) says
where each one is declared.

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
    `${panelKinds.length} viz types, ${valueFormats.length} value formats`,
);
