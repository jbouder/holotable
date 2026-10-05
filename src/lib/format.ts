import type { ValueFormat } from "@/lib/ir";
import type { NumberDisplay } from "@/lib/panels/presentation";

/**
 * Format a numeric value according to the panel's declared format, and the
 * number options a kind takes (#115). With no options it writes exactly what
 * it always has.
 */
export function formatValue(
  value: unknown,
  format?: ValueFormat,
  display: NumberDisplay = {},
): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return String(value ?? "");
  return withUnit(formatNumberAs(n, format, display), display.unit);
}

function formatNumberAs(n: number, format: ValueFormat | undefined, d: NumberDisplay) {
  switch (format) {
    case "bytes":
      return formatBytes(n, d.decimals);
    case "percent":
      return `${fixed(n, d.decimals ?? 2, d)}%`;
    case "ms":
      return `${fixed(n, d.decimals ?? 1, d)} ms`;
    default:
      if (d.decimals !== undefined || d.compact) return fixed(n, d.decimals, d);
      return formatNumber(n);
  }
}

/**
 * A unit reads as a word after the number (`12 hosts`), except one that is
 * already a suffix of what came before it (`4.1 KB/s`, `12%`).
 */
function withUnit(text: string, unit: string | undefined): string {
  if (!unit) return text;
  return /^[/%]/.test(unit) ? `${text}${unit}` : `${text} ${unit}`;
}

/**
 * `decimals` fixed when given; otherwise at most `max` digits, as the format
 * always rounded. Grouped, and compact on request.
 */
function fixed(n: number, decimals: number | undefined, d: NumberDisplay): string {
  if (decimals === undefined && !d.compact) return String(round(n, 2));
  return n.toLocaleString(undefined, {
    notation: d.compact ? "compact" : "standard",
    minimumFractionDigits: decimals ?? 0,
    maximumFractionDigits: decimals ?? 1,
  });
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function formatNumber(n: number): string {
  if (Math.abs(n) >= 1000)
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return String(round(n, 3));
}

function formatBytes(n: number, decimals?: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = n;
  let i = 0;
  while (Math.abs(value) >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const text = decimals === undefined ? String(round(value, 2)) : value.toFixed(decimals);
  return `${text} ${units[i]}`;
}
