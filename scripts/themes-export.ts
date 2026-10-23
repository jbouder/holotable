import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseThemeDecls } from "@/lib/color/contrast";
import {
  checkThemeFile,
  OPTIONAL_THEME_FILE_TOKENS,
  parseThemeFile,
  SHADOWS,
  type Shadow,
  THEME_FILE_TOKENS,
} from "@/lib/color/theme-file";
import { PALETTE_INFO } from "@/lib/theme";

/**
 * A built-in theme as a THEME_FILE (#508):
 * `npm run --silent themes:export graphite -- --as acme` prints JSON an
 * operator can start from. The file must not reuse a built-in name, so it is
 * written as `<name>-copy` unless `--as <name>` says otherwise. The output is
 * held to the boot checks before it is printed, and `test/theme-file.test.ts`
 * holds every exportable built-in to them too. High contrast is not
 * exportable: its flat surfaces are below the operator tier on purpose (#506).
 */
export function exportTheme(css: string, palette: string, as?: string) {
  const info = PALETTE_INFO.find((p) => p.name === palette);
  if (!info) throw new Error(`no built-in theme "${palette}"`);
  const blocks = parseThemeDecls(css).filter((b) => b.palette === palette);
  const scheme = (name: "light" | "dark") => {
    const decls = blocks.find((b) => b.scheme === name)?.decls ?? {};
    // An alias (`--code-keyword: var(--primary)`) is written as its value.
    const value = (token: string): string => {
      const v = decls[token];
      const alias = v && /^var\(--([a-z0-9-]+)\)$/.exec(v);
      return alias ? value(alias[1]) : v;
    };
    const tokens = Object.fromEntries(THEME_FILE_TOKENS.map((t) => [t, value(t)]));
    // Written only when it is not what a file that leaves it out gets.
    for (const [t, fallback] of Object.entries(OPTIONAL_THEME_FILE_TOKENS)) {
      if (decls[t] && decls[t] !== fallback) tokens[t] = value(t);
    }
    return tokens;
  };
  const radius = blocks.find((b) => b.scheme === "dark")?.decls.radius;
  // The card's lift by the name whose two values the theme's blocks carry.
  const lift = (scheme: "light" | "dark") =>
    blocks.find((b) => b.scheme === scheme)?.decls["shadow-card"];
  const shadow = (Object.keys(SHADOWS) as Shadow[]).find(
    (s) => SHADOWS[s].dark === lift("dark") && SHADOWS[s].light === lift("light"),
  );
  if (!shadow) throw new Error(`"${palette}" has a card shadow no theme file can name`);
  return {
    name: as ?? `${palette}-copy`,
    // A new name gets a label from it, so the controls never show two Graphites.
    label: as
      ? as.replace(/(^|-)([a-z])/g, (_, d, c) => `${d ? " " : ""}${c.toUpperCase()}`)
      : `${info.label} (copy)`,
    description: info.description,
    ...(radius && radius !== "0" ? { radius } : {}),
    // `none` is what a file that names none gets.
    ...(shadow !== "none" ? { shadow } : {}),
    light: scheme("light"),
    dark: scheme("dark"),
  };
}

function main(argv: string[]): number {
  const asAt = argv.indexOf("--as");
  const as = asAt >= 0 ? argv[asAt + 1] : undefined;
  const palette = argv.find(
    (a, i) => !a.startsWith("--") && (asAt < 0 || i !== asAt + 1),
  );
  if (!palette || (asAt >= 0 && !as)) {
    process.stderr.write(
      "usage: npm run --silent themes:export <theme> [-- --as <name>]\n",
    );
    return 2;
  }
  const css = readFileSync("src/app/globals.css", "utf8");
  const file = exportTheme(css, palette, as);
  // Held to the boot checks here, so a bad name or a theme below the bar
  // fails now rather than when a server starts with it.
  const parsed = parseThemeFile(JSON.stringify(file));
  const problems = parsed.theme ? checkThemeFile(parsed.theme) : parsed.problems;
  if (problems.length > 0) {
    process.stderr.write(`"${palette}" does not export as a valid THEME_FILE:\n`);
    for (const p of problems) process.stderr.write(`  ${p}\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify(file, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
