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
  site: process.env.DOCS_SITE_URL || "https://holotable-docs.vibeproject.workers.dev",
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
      customCss: ["./src/styles/custom.css"],
      // The app's header mark (lucide LayoutDashboard in --primary), beside
      // the title rather than replacing it, as the app's nav bar has it.
      logo: {
        light: "./src/assets/logo-light.svg",
        dark: "./src/assets/logo-dark.svg",
        alt: "",
      },
      favicon: "/favicon.svg",
      components: {
        Header: "./src/components/Header.astro",
        ThemeSelect: "./src/components/ThemeSelect.astro",
        SocialIcons: "./src/components/SocialIcons.astro",
      },
      // Fails the build on a broken internal link or heading anchor, so a
      // renamed page cannot silently orphan a reference.
      plugins: [starlightLinksValidator({ errorOnRelativeLinks: false })],
      sidebar: [
        {
          label: "Getting started",
          items: [
            { label: "Introduction", slug: "getting-started/introduction" },
            { label: "Quick start", slug: "getting-started/quick-start" },
            {
              label: "Your first dashboard",
              slug: "getting-started/your-first-dashboard",
            },
            { label: "Demo data", slug: "getting-started/demo-data" },
            { label: "Settings and your account", slug: "getting-started/settings" },
            {
              label: "Writing specs with Claude Code",
              slug: "getting-started/writing-specs-with-claude-code",
            },
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
            { label: "Editing a dashboard", slug: "concepts/editing-a-dashboard" },
            { label: "Dashboard variables", slug: "concepts/variables" },
            { label: "Annotations", slug: "concepts/annotations" },
            { label: "Drilldown", slug: "concepts/drilldown" },
            { label: "Prometheus sources", slug: "concepts/prometheus-sources" },
          ],
        },
        {
          label: "Architecture",
          items: [
            { label: "Invariants", slug: "architecture/invariants" },
            { label: "Authorization model", slug: "architecture/authorization" },
            { label: "Scaling and the poller", slug: "architecture/scaling" },
            { label: "Data model", slug: "architecture/data-model" },
            { label: "Motion", slug: "architecture/motion" },
            { label: "Accessibility", slug: "architecture/accessibility" },
            {
              label: "ADR 1: Multi-source generation",
              slug: "architecture/decisions/0001-multi-source-generation",
            },
            {
              label: "ADR 2: Source kinds",
              slug: "architecture/decisions/0002-source-kinds",
            },
          ],
        },
        {
          label: "Operations",
          items: [
            { label: "Keycloak setup", slug: "operations/keycloak" },
            { label: "Demo mode", slug: "operations/demo-mode" },
            { label: "Hosted demo on Cloudflare", slug: "operations/cloudflare-demo" },
            { label: "Source secret references", slug: "operations/secret-references" },
            { label: "Prometheus sources", slug: "operations/prometheus" },
            { label: "Row-level filters", slug: "operations/row-level-filters" },
            { label: "Share links and embedding", slug: "operations/share-links" },
            { label: "Service-account API tokens", slug: "operations/api-tokens" },
            { label: "MCP server", slug: "operations/mcp" },
            { label: "AI provider", slug: "operations/ai-provider" },
            { label: "Startup validation", slug: "operations/startup-validation" },
            { label: "Security headers", slug: "operations/security-headers" },
            { label: "LLM rate limits and budgets", slug: "operations/llm-limits" },
            { label: "Health, readiness, and shutdown", slug: "operations/health-checks" },
            { label: "Prometheus metrics", slug: "operations/metrics" },
            { label: "Structured logging", slug: "operations/logging" },
            { label: "Audit log", slug: "operations/audit-log" },
            { label: "Database migrations", slug: "operations/migrations" },
            { label: "Deploying on Kubernetes", slug: "operations/kubernetes" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Configuration", slug: "reference/configuration" },
            { label: "Visualization types", slug: "reference/visualization-types" },
            { label: "Panel options", slug: "reference/panel-options" },
            { label: "API routes", slug: "reference/api-routes" },
          ],
        },
      ],
    }),
  ],
});
