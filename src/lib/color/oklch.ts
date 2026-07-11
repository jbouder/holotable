/**
 * Resolve OKLCH design tokens to concrete sRGB hex strings.
 *
 * ECharts renders on canvas and cannot consume `oklch(...)` values or CSS
 * custom properties. Our Tailwind v4 theme expresses colors as OKLCH tokens, so
 * before handing colors to ECharts we convert them to `#rrggbb`.
 *
 * Implements the OKLCH -> OKLab -> linear sRGB -> gamma sRGB pipeline
 * (Björn Ottosson's OKLab).
 */

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return clamp01(v);
}

function toHexChannel(c: number): string {
  return Math.round(c * 255)
    .toString(16)
    .padStart(2, "0");
}

export interface Oklch {
  l: number; // 0..1
  c: number; // chroma
  h: number; // degrees
}

export function oklchToHex({ l, c, h }: Oklch): string {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);

  // OKLab -> LMS
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;

  const l3 = l_ * l_ * l_;
  const m3 = m_ * m_ * m_;
  const s3 = s_ * s_ * s_;

  // LMS -> linear sRGB
  const r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const bl = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;

  return `#${toHexChannel(linearToSrgb(r))}${toHexChannel(linearToSrgb(g))}${toHexChannel(linearToSrgb(bl))}`;
}

const OKLCH_RE =
  /^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*[\d.]+%?\s*)?\)$/i;

/**
 * Parse a CSS `oklch(...)` string and return a hex color. Accepts lightness as
 * a percentage or 0..1 number. Returns null if the string is not OKLCH.
 */
export function resolveOklchToken(value: string): string | null {
  const m = OKLCH_RE.exec(value.trim());
  if (!m) return null;
  const lRaw = m[1];
  const l = lRaw.endsWith("%") ? parseFloat(lRaw) / 100 : parseFloat(lRaw);
  const c = parseFloat(m[2]);
  const h = parseFloat(m[3]);
  return oklchToHex({ l, c, h });
}

/**
 * Resolve any color token to a hex string ECharts can use. OKLCH strings are
 * converted; already-hex/rgb strings are passed through unchanged.
 */
export function resolveColor(value: string): string {
  return resolveOklchToken(value) ?? value;
}

/**
 * The chart palette, defined as OKLCH tokens and resolved to hex for canvas.
 * Keeping the source-of-truth in OKLCH matches the CSS theme.
 */
export const OKLCH_PALETTE: Oklch[] = [
  { l: 0.62, c: 0.19, h: 259 },
  { l: 0.7, c: 0.16, h: 160 },
  { l: 0.7, c: 0.18, h: 70 },
  { l: 0.65, c: 0.22, h: 20 },
  { l: 0.6, c: 0.2, h: 300 },
  { l: 0.72, c: 0.15, h: 195 },
];

export function chartPalette(): string[] {
  return OKLCH_PALETTE.map(oklchToHex);
}
