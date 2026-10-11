import { readFileSync } from "node:fs";
import { parseThemeDecls } from "@/lib/color/contrast";
import { THEME_FILE_TOKENS } from "@/lib/color/theme-file";
import { PALETTE_INFO } from "@/lib/theme";

/**
 * A built-in theme as a THEME_FILE (#508): `npm run themes:export graphite`
 * prints JSON an operator can start from. The file must not reuse a built-in
 * name, so it is written as `<name>-copy` unless `--as <name>` says otherwise.
 * `test/theme-file.test.ts` holds every export to the same checks as boot.
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
    return Object.fromEntries(THEME_FILE_TOKENS.map((t) => [t, value(t)]));
  };
  const radius = blocks.find((b) => b.scheme === "dark")?.decls.radius;
  return {
    name: as ?? `${palette}-copy`,
    label: as ? info.label : `${info.label} (copy)`,
    description: info.description,
    ...(radius && radius !== "0" ? { radius } : {}),
    light: scheme("light"),
    dark: scheme("dark"),
  };
}

const [palette, flag, as] = process.argv.slice(2);
if (palette && import.meta.url === `file://${process.argv[1]}`) {
  const css = readFileSync("src/app/globals.css", "utf8");
  process.stdout.write(
    `${JSON.stringify(exportTheme(css, palette, flag === "--as" ? as : undefined), null, 2)}\n`,
  );
}
