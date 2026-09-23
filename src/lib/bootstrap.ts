import { DEFAULT_MOTION, MOTION_STORAGE_KEY, REDUCED_MOTION_QUERY } from "@/lib/motion";
import { DEFAULT_THEME, THEME_STORAGE_KEY } from "@/lib/theme";

/**
 * The inline script the root layout runs in `<head>` before first paint.
 *
 * It resolves the stored theme onto `data-theme` and the stored motion
 * preference onto `data-motion`, so neither flashes. It lives here rather than
 * as a literal in the layout so the keys and defaults come from the modules
 * that own them, and `test/bootstrap.test.ts` can run it against a fake
 * document. It is built from constants only, never from request data, so it
 * has no injection surface; the layout stamps it with the CSP nonce.
 */
export const BOOTSTRAP_SCRIPT = `(function(){var d=document.documentElement;try{var p=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(p!=="dark"&&p!=="light"&&p!=="system")p=${JSON.stringify(DEFAULT_THEME)};var t=p==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):p;d.dataset.theme=t;d.style.colorScheme=t}catch(e){}try{var m=localStorage.getItem(${JSON.stringify(MOTION_STORAGE_KEY)});if(m!=="system"&&m!=="reduce"&&m!=="allow")m=${JSON.stringify(DEFAULT_MOTION)};d.dataset.motion=m==="system"?(matchMedia(${JSON.stringify(REDUCED_MOTION_QUERY)}).matches?"reduce":"allow"):m}catch(e){}})()`;
