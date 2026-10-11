import { readFileSync } from "node:fs";
import {
  checkThemeFile,
  parseThemeFile,
  type ThemeFile,
  themeFileInfo,
} from "@/lib/color/theme-file";
import { log } from "@/lib/log";
import { registerOperatorPalette } from "@/lib/theme";

/**
 * The operator's theme from `THEME_FILE` (#508), read once per process.
 *
 * `src/lib/startup.ts` checks the same file at boot and refuses to start in
 * production when it fails. In development a failing file is a warning and
 * this loads nothing, so the app runs on the built-in themes.
 */

export interface LoadedThemeFile {
  theme: ThemeFile | null;
  /** Why it did not load: unreadable, malformed, or below the bar. */
  problems: string[];
  /** The file could not be read at all. */
  unreadable: boolean;
}

export function loadThemeFile(path: string): LoadedThemeFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as { code?: string }).code ?? "error";
    return {
      theme: null,
      problems: [`${path} could not be read (${code})`],
      unreadable: true,
    };
  }
  const parsed = parseThemeFile(text);
  if (!parsed.theme) return { theme: null, problems: parsed.problems, unreadable: false };
  let failures: string[];
  try {
    failures = checkThemeFile(parsed.theme);
  } catch (err) {
    // Whatever the check could not measure is the file's problem to report,
    // never an error that takes the server down without naming THEME_FILE.
    failures = [`could not be measured (${(err as Error).message})`];
  }
  return failures.length > 0
    ? { theme: null, problems: failures, unreadable: false }
    : { theme: parsed.theme, problems: [], unreadable: false };
}

let loaded: ThemeFile | null | undefined;

/**
 * The loaded theme, or `null`. The first call also registers it with the
 * theme controls (`paletteInfo()`), so every server render after it lists it.
 */
export function operatorTheme(): ThemeFile | null {
  if (loaded !== undefined) return loaded;
  const path = process.env.THEME_FILE;
  if (!path) {
    loaded = null;
  } else {
    const result = loadThemeFile(path);
    loaded = result.theme;
    if (!result.theme) {
      log.warn("theme_file.not_loaded", { problems: result.problems.length });
    }
  }
  registerOperatorPalette(loaded ? themeFileInfo(loaded) : null);
  return loaded;
}
