import { isPalette, isTheme, type Palette, type Theme } from "@/lib/theme";

/**
 * The theme an embed is drawn in (#509).
 *
 * An embed lives in someone else's page, where our storage is empty or
 * partitioned, so its theme comes with the link: `?theme=<palette>` and
 * `?scheme=light|dark|system`. Both are checked against the shipped names
 * here; anything else is absent, so the default applies, and an unchecked
 * value never reaches markup, a header or a script. The parameters change
 * how the page looks and nothing about what it may show: that is the token's
 * alone.
 */
export interface EmbedAppearance {
  palette: Palette | null;
  scheme: Theme | null;
}

export const NO_EMBED_APPEARANCE: EmbedAppearance = { palette: null, scheme: null };

/** The query parameters, validated. */
export function embedAppearance(params: URLSearchParams): EmbedAppearance {
  const palette = params.get("theme");
  const scheme = params.get("scheme");
  return {
    palette: isPalette(palette) ? palette : null,
    scheme: isTheme(scheme) ? scheme : null,
  };
}

/**
 * The validated appearance as the proxy hands it to the root layout, which
 * validates it again when it reads it back: a request header is the request's
 * to send, and the proxy strips any it brought.
 */
export function embedAppearanceHeader(a: EmbedAppearance): string {
  return `${a.palette ?? ""}:${a.scheme ?? ""}`;
}

export function readEmbedAppearanceHeader(value: string | null): EmbedAppearance {
  if (!value) return NO_EMBED_APPEARANCE;
  const [palette, scheme] = value.split(":");
  return {
    palette: isPalette(palette) ? palette : null,
    scheme: isTheme(scheme) ? scheme : null,
  };
}

/**
 * A share link's href with a chosen appearance. No choice writes nothing,
 * so an unchanged link is exactly the link it always was.
 */
export function withEmbedAppearance(href: string, a: EmbedAppearance): string {
  const url = new URL(href);
  if (a.palette) url.searchParams.set("theme", a.palette);
  if (a.scheme) url.searchParams.set("scheme", a.scheme);
  return url.toString();
}
