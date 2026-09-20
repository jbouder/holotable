import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // `pg` uses Node-only APIs. `libpg-query` is the PostgreSQL parser behind the
  // SQL guard; it loads its WebAssembly binary from disk next to its own
  // entrypoint, which only resolves when Node requires it from node_modules.
  serverExternalPackages: ["pg", "libpg-query"],
};

export default nextConfig;
