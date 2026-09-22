/**
 * This document's Content-Security-Policy nonce, read back out of the DOM.
 *
 * The policy `src/proxy.ts` sets is `style-src 'self' 'nonce-…'` with no
 * `'unsafe-inline'`, which is the point of it: a `<style>` element the browser
 * did not see a nonce on does not apply. CodeMirror builds its stylesheet at
 * runtime and mounts it into `document.head`, so without a nonce the editor
 * renders as unstyled text — and it has a facet, `EditorView.cspNonce`, for
 * exactly this.
 *
 * The nonce is read from the document rather than passed down as a prop from
 * the server, because the two can differ. A client-side navigation to the
 * editor fetches a fresh response with a *fresh* nonce, but the CSP in force
 * is still the one the original document arrived with — a prop from the newer
 * response would name a nonce this document's policy has never heard of. The
 * elements already in the page carry the only nonce that works.
 *
 * Browsers hide the nonce from `getAttribute` after parsing, to keep it out of
 * reach of CSS-based exfiltration, but keep the `nonce` IDL property readable
 * by same-origin script. That is what this reads, and it is why the attribute
 * selector still matches an element whose attribute reads as empty.
 */
export function documentNonce(): string {
  if (typeof document === "undefined") return "";
  for (const element of document.querySelectorAll<HTMLElement>("[nonce]")) {
    if (element.nonce) return element.nonce;
  }
  return "";
}
