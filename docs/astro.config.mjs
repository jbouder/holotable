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
  // Pages that moved when the site was regrouped by audience (user guide,
  // integrations, administration, operations). Static output, so each old
  // path becomes a meta-refresh page; links in the wild keep resolving.
  redirects: {
    "/concepts/editing-a-dashboard/": "/guide/editing-a-dashboard/",
    "/concepts/variables/": "/guide/variables/",
    "/concepts/annotations/": "/guide/annotations/",
    "/concepts/drilldown/": "/guide/drilldown/",
    "/getting-started/settings/": "/guide/settings/",
    "/operations/share-links/": "/integrations/share-links/",
    "/operations/api-tokens/": "/integrations/api-tokens/",
    "/operations/mcp/": "/integrations/mcp/",
    "/getting-started/writing-specs-with-claude-code/":
      "/integrations/writing-specs-with-claude-code/",
    "/operations/keycloak/": "/admin/keycloak/",
    "/operations/ai-provider/": "/admin/ai-provider/",
    "/operations/llm-limits/": "/admin/llm-limits/",
    "/operations/secret-references/": "/admin/secret-references/",
    "/operations/prometheus/": "/admin/prometheus/",
    "/operations/row-level-filters/": "/admin/row-level-filters/",
    "/operations/demo-mode/": "/admin/demo-mode/",
    "/getting-started/demo-data/": "/operations/demo-data/",
    // The decision records were folded into the pages that state the decision.
    "/architecture/decisions/0001-multi-source-generation/":
      "/concepts/generating-a-panel/#more-than-one-source",
    "/architecture/decisions/0002-source-kinds/": "/architecture/data-model/#source-kinds",
  },
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
          ],
        },
        {
          label: "Using Holotable",
          items: [
            { label: "Viewing a dashboard", slug: "guide/viewing-a-dashboard" },
            { label: "Editing a dashboard", slug: "guide/editing-a-dashboard" },
            { label: "Chat", slug: "guide/chat" },
            { label: "Dashboard chat", slug: "guide/dashboard-chat" },
            { label: "Dashboard variables", slug: "guide/variables" },
            { label: "Annotations", slug: "guide/annotations" },
            { label: "Drilldown", slug: "guide/drilldown" },
            { label: "Settings and your account", slug: "guide/settings" },
          ],
        },
        {
          label: "Integrations",
          items: [
            { label: "Share links and embedding", slug: "integrations/share-links" },
            { label: "Service-account API tokens", slug: "integrations/api-tokens" },
            { label: "MCP server", slug: "integrations/mcp" },
            {
              label: "Writing specs with Claude Code",
              slug: "integrations/writing-specs-with-claude-code",
            },
          ],
        },
        {
          label: "How it works",
          items: [
            { label: "Overview", slug: "concepts/how-it-works" },
            { label: "The shared IR", slug: "concepts/the-shared-ir" },
            { label: "Generating a panel", slug: "concepts/generating-a-panel" },
            { label: "Executing a panel", slug: "concepts/executing-a-panel" },
            { label: "Streaming and rendering", slug: "concepts/streaming-and-rendering" },
            { label: "Prometheus sources", slug: "concepts/prometheus-sources" },
          ],
        },
        {
          label: "Administration",
          items: [
            { label: "Keycloak setup", slug: "admin/keycloak" },
            { label: "AI provider", slug: "admin/ai-provider" },
            { label: "LLM rate limits and budgets", slug: "admin/llm-limits" },
            { label: "Source secret references", slug: "admin/secret-references" },
            { label: "Prometheus endpoints", slug: "admin/prometheus" },
            { label: "Row-level filters", slug: "admin/row-level-filters" },
            { label: "Demo mode", slug: "admin/demo-mode" },
          ],
        },
        {
          label: "Operations",
          items: [
            { label: "Deploying on Kubernetes", slug: "operations/kubernetes" },
            { label: "Database migrations", slug: "operations/migrations" },
            { label: "Startup validation", slug: "operations/startup-validation" },
            { label: "Health, readiness, and shutdown", slug: "operations/health-checks" },
            { label: "Prometheus metrics", slug: "operations/metrics" },
            { label: "Structured logging", slug: "operations/logging" },
            { label: "Audit log", slug: "operations/audit-log" },
            { label: "Security headers", slug: "operations/security-headers" },
            { label: "Demo data", slug: "operations/demo-data" },
            { label: "Hosted demo on Cloudflare", slug: "operations/cloudflare-demo" },
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
            { label: "Custom visuals", slug: "architecture/custom-visuals" },
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
