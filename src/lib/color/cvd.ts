import type { Rgb } from "@/lib/color/contrast";

/**
 * Color-vision deficiency, simulated, and a perceptual distance (#504).
 *
 * The simulation is Machado, Oliveira and Fernandes (2009), "A
 * Physiologically-based Model for Simulation of Color Vision Deficiency", at
 * full severity: one 3×3 matrix per deficiency, applied in linear sRGB. The
 * distance is Euclidean in OKLab (Ottosson), where 0.02 is about the smallest
 * difference a reader notices side by side and 0.1 is plainly different.
 */

export const DEFICIENCIES = ["protanopia", "deuteranopia", "tritanopia"] as const;
export type Deficiency = (typeof DEFICIENCIES)[number];

/** Machado et al. 2009, severity 1.0, in linear sRGB. */
export const MACHADO: Record<Deficiency, readonly (readonly number[])[]> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (c: number) => {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
};

/** How `rgb` looks to a reader with `deficiency`, as sRGB 0–255. */
export function simulate(rgb: Rgb, deficiency: Deficiency): Rgb {
  const lin = rgb.map(toLinear);
  const m = MACHADO[deficiency];
  const out = m.map((row) => row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]);
  return [fromLinear(out[0]), fromLinear(out[1]), fromLinear(out[2])];
}

/** sRGB 0–255 to OKLab `[L, a, b]`. */
export function toOklab(rgb: Rgb): [number, number, number] {
  const [r, g, b] = rgb.map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Perceptual distance between two colors (OKLab ΔE). */
export function deltaE(a: Rgb, b: Rgb): number {
  const [l1, a1, b1] = toOklab(a);
  const [l2, a2, b2] = toOklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** A color's OKLab lightness and hue (degrees), for the rules that read them. */
export function lightnessHue(rgb: Rgb): { l: number; h: number } {
  const [l, a, b] = toOklab(rgb);
  return { l, h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}
