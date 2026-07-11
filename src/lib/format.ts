import type { ValueFormat } from "@/lib/ir";

/** Format a numeric value according to the panel's declared format. */
export function formatValue(value: unknown, format?: ValueFormat): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return String(value ?? "");

  switch (format) {
    case "bytes":
      return formatBytes(n);
    case "percent":
      return `${round(n, 2)}%`;
    case "ms":
      return `${round(n, 1)} ms`;
    case "number":
    default:
      return formatNumber(n);
  }
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function formatNumber(n: number): string {
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return String(round(n, 3));
}

function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = n;
  let i = 0;
  while (Math.abs(value) >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${round(value, 2)} ${units[i]}`;
}
