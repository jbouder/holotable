/** "12 KB", "840 B". Storage quotas are counted in UTF-16 units; close enough. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${Math.round(n / 1024)} KB`;
}

/** "saved just now", "saved 5 minutes ago", "saved 3 days ago". */
export function formatSavedAt(savedAt: number, now: number): string {
  const s = Math.max(0, Math.floor((now - savedAt) / 1000));
  const unit = (n: number, word: string) => `saved ${n} ${word}${n === 1 ? "" : "s"} ago`;
  if (s < 60) return "saved just now";
  if (s < 3600) return unit(Math.floor(s / 60), "minute");
  if (s < 86_400) return unit(Math.floor(s / 3600), "hour");
  return unit(Math.floor(s / 86_400), "day");
}
