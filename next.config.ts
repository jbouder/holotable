import type { NextConfig } from "next";
import { staticSecurityHeaders } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  output: "standalone",
  // `pg` uses Node-only APIs. `libpg-query` is the PostgreSQL parser behind the
  // SQL guard; it loads its WebAssembly binary from disk next to its own
  // entrypoint, which only resolves when Node requires it from node_modules.
  serverExternalPackages: ["pg", "libpg-query"],
  // The dev-tools badge sits over the top-left of the nav bar, which is where
  // the brand and the first link are. Development-only either way — it is not
  // emitted by `next build` — so turning it off costs nothing in production.
  devIndicators: false,
  // The per-response headers that do not vary by request. The
  // Content-Security-Policy needs a fresh nonce each time and is set by
  // src/proxy.ts. `next build` runs with NODE_ENV=production, so a production
  // build carries HSTS and `next dev` does not; this only adds headers, so the
  // SSE stream under /api/dashboards/[id]/stream is not buffered or altered.
  // Chat (#416) is called Explore and lives at /explore (#431); a /chat
  // link or bookmark from the weeks between lands on the same conversation.
  async redirects() {
    return [
      { source: "/chat", destination: "/explore", permanent: true },
      { source: "/chat/:id", destination: "/explore/:id", permanent: true },
    ];
  },
  async headers() {
    return [
      {
        // Everything but a share link's embed page (#65).
        source: "/:path((?!embed(?:/|$)).*)",
        headers: staticSecurityHeaders({
          production: process.env.NODE_ENV === "production",
        }),
      },
      {
        // Framable by the origins its token names, which the proxy writes
        // into `frame-ancestors`; so no `X-Frame-Options: DENY` here.
        source: "/embed/:path*",
        headers: staticSecurityHeaders({
          production: process.env.NODE_ENV === "production",
          framable: true,
        }),
      },
    ];
  },
};

export default nextConfig;
