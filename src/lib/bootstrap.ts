import { DEFAULT_MOTION, MOTION_STORAGE_KEY, REDUCED_MOTION_QUERY } from "@/lib/motion";
import {
  DEFAULT_PALETTE,
  DEFAULT_THEME,
  type Palette,
  PALETTE_INFO,
  PALETTE_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from "@/lib/theme";

/**
 * The inline script the root layout runs in `<head>` before first paint.
 *
 * It resolves the stored theme onto `data-theme`, the stored palette onto
 * `data-palette` and the stored motion preference onto `data-motion`, so
 * none of them flashes. It lives here rather than
 * as a literal in the layout so the keys and defaults come from the modules
 * that own them, and `test/bootstrap.test.ts` can run it against a fake
 * document. It is built from constants and the validated default palette
 * only, never from request data, so it has no injection surface; the layout stamps it with the CSP nonce.
 */
export function bootstrapScript(defaultPalette: Palette = DEFAULT_PALETTE): string {
  // The palette (#503): a stored one the app ships, else the server's default,
  // which `validateConfig` has already held to the shipped list.
  const shipped = JSON.stringify(PALETTE_INFO.map((p) => p.name));
  return `(function(){var d=document.documentElement;try{var p=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(p!=="dark"&&p!=="light"&&p!=="system")p=${JSON.stringify(DEFAULT_THEME)};var t=p==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):p;d.dataset.theme=t;d.style.colorScheme=t}catch(e){}try{var q=localStorage.getItem(${JSON.stringify(PALETTE_STORAGE_KEY)});if(${shipped}.indexOf(q)<0)q=${JSON.stringify(defaultPalette)};d.dataset.palette=q}catch(e){}try{var m=localStorage.getItem(${JSON.stringify(MOTION_STORAGE_KEY)});if(m!=="system"&&m!=="reduce"&&m!=="allow")m=${JSON.stringify(DEFAULT_MOTION)};d.dataset.motion=m==="system"?(matchMedia(${JSON.stringify(REDUCED_MOTION_QUERY)}).matches?"reduce":"allow"):m}catch(e){}})()`;
}

/** The script with the built-in default palette, for a test. */
export const BOOTSTRAP_SCRIPT = bootstrapScript();
