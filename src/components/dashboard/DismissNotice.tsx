"use client";

import * as React from "react";

/**
 * Takes a one-time notice's query parameter back out of the address bar once
 * it has been shown, so a reload or a copied link does not repeat it. It
 * rewrites history in place rather than navigating, which would re-render the
 * page it is sitting on.
 */
export function DismissNotice({ param }: { param: string }) {
  React.useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(param)) return;
    url.searchParams.delete(param);
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [param]);
  return null;
}
