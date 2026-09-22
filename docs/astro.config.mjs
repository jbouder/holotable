// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightLinksValidator from "starlight-links-validator";

/**
 * Holotable documentation site.
 *
 * Static output only: the site never calls the Holotable API, holds no secrets,
 * and needs no runtime binding. It is deployed to Cloudflare Workers as static
 * assets (see wrangler.jsonc), so no SSR adapter is required.
 */
export default defineConfig({
  site: process.env.DOCS_SITE_URL || "https://holotable-docs.pages.dev",
  output: "static",
  srcDir: "./src",
  publicDir: "./public",
  outDir: "./dist",
  integrations: [
    starlight({
      title: "Holotable",
      description:
        "Natural-language monitoring dashboards. The model authors a validated spec; the server runs the guarded SQL.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/jbouder/holotable",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/jbouder/holotable/edit/main/docs/",
      },
      lastUpdated: true,
      // Fails the build on a broken internal link or heading anchor, so a
      // renamed page cannot silently orphan a reference.
      plugins: [starlightLinksValidator({ errorOnRelativeLinks: false })],
      sidebar: [
        {
          label: "Getting started",
          items: [
            { label: "Introduction", slug: "getting-started/introduction" },
            { label: "Quick start", slug: "getting-started/quick-start" },
            { label: "Demo data", slug: "getting-started/demo-data" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "How it works", slug: "concepts/how-it-works" },
            { label: "The shared IR", slug: "concepts/the-shared-ir" },
            { label: "Generating a panel", slug: "concepts/generating-a-panel" },
            { label: "Executing a panel", slug: "concepts/executing-a-panel" },
            { label: "Streaming and rendering", slug: "concepts/streaming-and-rendering" },
          ],
        },
        {
          label: "Architecture",
          items: [
            { label: "Invariants", slug: "architecture/invariants" },
            { label: "Authorization model", slug: "architecture/authorization" },
            { label: "Scaling and the poller", slug: "architecture/scaling" },
            { label: "Data model", slug: "architecture/data-model" },
          ],
        },
        {
          label: "Operations",
          items: [
            { label: "Keycloak setup", slug: "operations/keycloak" },
            { label: "Source secret references", slug: "operations/secret-references" },
            { label: "AI provider", slug: "operations/ai-provider" },
            { label: "Startup validation", slug: "operations/startup-validation" },
            { label: "Security headers", slug: "operations/security-headers" },
            { label: "LLM rate limits and budgets", slug: "operations/llm-limits" },
            { label: "Health, readiness, and shutdown", slug: "operations/health-checks" },
            { label: "Prometheus metrics", slug: "operations/metrics" },
            { label: "Structured logging", slug: "operations/logging" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Configuration", slug: "reference/configuration" },
            { label: "Visualization types", slug: "reference/visualization-types" },
            { label: "API routes", slug: "reference/api-routes" },
          ],
        },
      ],
    }),
  ],
});
