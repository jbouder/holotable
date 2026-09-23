/**
 * The slice of the Web Storage API this app actually uses.
 *
 * Two features keep state in `localStorage` — editor draft autosave (#118) and
 * recent prompts (#83) — and both have the same two problems with it: reading
 * it throws outright in some privacy modes, and it is not there at all on the
 * server. Naming the subset once means a test can hand either feature a plain
 * object, and `browserStorage()` is the single place the `typeof window` guard
 * lives.
 */
export interface BrowserStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

/** `localStorage` if this browser has one it will actually hand over. */
export function browserStorage(): BrowserStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
