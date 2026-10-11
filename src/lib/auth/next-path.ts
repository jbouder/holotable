/**
 * Where to send the browser after sign-in, in either mode: a same-origin path, or `/`.
 *
 * Only a path is accepted (`/dashboards?x=1`), never a URL. `//host` and
 * `/\host` are protocol-relative to a browser, a scheme names another origin,
 * and control characters can split a `Location` header, so all of them fall
 * back to `/` rather than being repaired.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || next.length > 2048) return "/";
  if (!next.startsWith("/")) return "/";
  if (next.startsWith("//") || next.startsWith("/\\")) return "/";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return "/";
  // Anything a URL parser resolves off this origin is refused too.
  const base = "http://holotable.invalid";
  try {
    if (new URL(next, base).origin !== base) return "/";
  } catch {
    return "/";
  }
  return next;
}
