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
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
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

export function oklchToHex(color: Oklch): string {
  const [r, g, bl] = oklchToLinear(color);
  return `#${toHexChannel(linearToSrgb(r))}${toHexChannel(linearToSrgb(g))}${toHexChannel(linearToSrgb(bl))}`;
}

/** OKLCH as linear sRGB, unclamped: a channel outside 0..1 is out of gamut. */
function oklchToLinear({ l, c, h }: Oklch): [number, number, number] {
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

  return [r, g, bl];
}

/**
 * OKLCH as hex, brought into sRGB by lowering its chroma rather than by
 * clipping each channel, which would turn its hue (a dark yellow clipped
 * channel by channel goes olive or orange). Lightness and hue are kept.
 */
export function oklchToHexInGamut(color: Oklch): string {
  const inside = (c: number) =>
    oklchToLinear({ ...color, c }).every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  if (inside(color.c)) return oklchToHex(color);
  let lo = 0;
  let hi = color.c;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (inside(mid)) lo = mid;
    else hi = mid;
  }
  return oklchToHex({ ...color, c: lo });
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** A `#rrggbb` color as OKLCH; a gray's hue is 0. */
export function hexToOklch(hex: string): Oklch {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
    srgbToLinear(v / 255),
  );
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const l = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const c = Math.hypot(a, bb);
  const h = c < 1e-6 ? 0 : ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
  return { l, c, h };
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

const LAB_RE = /^lab\(\s*([-\d.]+%?)\s+([-\d.]+)\s+([-\d.]+)\s*(?:\/\s*[\d.]+%?\s*)?\)$/i;

/**
 * CSS `lab()` (CIE Lab, D50) as hex. A production build's CSS pipeline
 * rewrites `oklch()` tokens into `lab()`, which is what a computed style then
 * hands back, so it has to be read as well as `oklch()` (#502).
 */
export function resolveLabToken(value: string): string | null {
  const m = LAB_RE.exec(value.trim());
  if (!m) return null;
  const l = parseFloat(m[1]);
  const a = parseFloat(m[2]);
  const b = parseFloat(m[3]);
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const e = 216 / 24389;
  const k = 24389 / 27;
  const inv = (t: number) => (t ** 3 > e ? t ** 3 : (116 * t - 16) / k);
  // XYZ against the D50 white point.
  const x = (0.3457 / 0.3585) * inv(fx);
  const y = l > k * e ? fy ** 3 : l / k;
  const z = ((1 - 0.3457 - 0.3585) / 0.3585) * inv(fz);
  // Bradford D50 -> D65.
  const x65 = 0.9554734527042182 * x - 0.023098536874261423 * y + 0.0632593086610217 * z;
  const y65 =
    -0.028369706963208136 * x + 1.0099954580058226 * y + 0.021041398966943008 * z;
  const z65 =
    0.012314001688319899 * x - 0.020507696433477912 * y + 1.3303659366080753 * z;
  // XYZ D65 -> linear sRGB.
  const r = 3.2409699419045226 * x65 - 1.537383177570094 * y65 - 0.4986107602930034 * z65;
  const g =
    -0.9692436362808796 * x65 + 1.8759675015077202 * y65 + 0.04155505740717559 * z65;
  const bl =
    0.05563007969699366 * x65 - 0.20397695888897652 * y65 + 1.0569715142428786 * z65;
  return `#${toHexChannel(linearToSrgb(r))}${toHexChannel(linearToSrgb(g))}${toHexChannel(linearToSrgb(bl))}`;
}

const RGB_RE =
  /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/i;

/** `rgb(r, g, b)` or `rgb(r g b)` as hex. */
function resolveRgb(value: string): string | null {
  const m = RGB_RE.exec(value.trim());
  if (!m) return null;
  const c = (v: string) =>
    Math.max(0, Math.min(255, Math.round(parseFloat(v))))
      .toString(16)
      .padStart(2, "0");
  return `#${c(m[1])}${c(m[2])}${c(m[3])}`;
}

/**
 * Anything else the browser can paint, as hex, by painting it: one pixel on a
 * canvas, read back. Only in a browser, and only for a syntax the parsers
 * above do not know; elsewhere the value comes back as it was.
 */
function resolveByCanvas(value: string): string | null {
  if (typeof document === "undefined") return null;
  try {
    const ctx = document.createElement("canvas").getContext("2d", {
      willReadFrequently: true,
    });
    if (!ctx) return null;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return null;
  }
}

const HEX_RE = /^#[0-9a-f]{6}$/i;

/**
 * Any CSS color as the `#rrggbb` a canvas, a blend or a contrast check can
 * use: `oklch()` as authored, `lab()` as a production build serves it, and
 * `rgb()`, converted here; any other syntax painted once in the browser.
 * A value nothing can read comes back unchanged.
 */
export function resolveColor(value: string): string {
  const v = value.trim();
  if (HEX_RE.test(v)) return v.toLowerCase();
  return (
    resolveOklchToken(v) ?? resolveLabToken(v) ?? resolveRgb(v) ?? resolveByCanvas(v) ?? v
  );
}
