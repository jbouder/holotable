import { expect, test } from "@playwright/test";
import { STUB_CHAT_REPLY } from "../src/lib/ai/stub";
import { SPEC_VERSION } from "../src/lib/ir";
import { PG_PORT, storageStatePath } from "./env";
import {
  createLinkedDashboards,
  DEMO_DASHBOARD,
  dashboardId,
  waitForPanels,
} from "./support/app";

/*
 * The flows around the core journey (#88): Explore, dashboard chat, a source
 * removed out from under a dashboard, and a viewer kept out of the editor.
 */

test("explore answers a question with a guarded query", async ({ page }) => {
  await page.goto("/explore");
  // The source is a chip in the prompt bar, like /dashboards/new (#362).
  await page.getByRole("button", { name: /^Data source:/ }).click();
  await page.getByRole("menuitemradio", { name: /Demo TimescaleDB metrics/ }).click();
  await page.keyboard.press("Escape");
  await page.locator("#prompt").fill("Which service is busiest?");
  await page.getByRole("button", { name: "Explore" }).click();
  // The recorded panel's SQL ran on the server: real rows, real services.
  const table = page.getByRole("region", { name: "Requests by service, table" });
  await expect(table.getByRole("cell", { name: "api", exact: true })).toBeVisible();

  // Start over asks, then clears the visit's answers.
  await page.locator("#main").getByRole("button", { name: "Start over" }).click();
  const dialog = page.getByRole("dialog", { name: "Start over?" });
  await expect(dialog).toContainText("The 1 answer from this visit is cleared");
  await dialog.getByRole("button", { name: "Start over" }).click();
  await expect(table).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "This session" })).toHaveCount(0);
});

test("new dashboard: Start over asks, then clears every version", async ({ page }) => {
  await page.goto("/dashboards/new");
  await page.getByLabel("Describe the dashboard").fill("Checkout service health");
  await page.getByRole("button", { name: "Generate" }).click();
  const preview = page.getByRole("region", { name: "Dashboard preview" });
  await expect(preview.getByRole("button", { name: "Save dashboard" })).toBeVisible();
  const startOver = page.locator("#main").getByRole("button", { name: "Start over" });
  const dialog = page.getByRole("dialog", { name: "Start over?" });

  // Cancel keeps the work.
  await startOver.click();
  await expect(dialog).toContainText("1 unsaved version is discarded");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(preview.getByRole("button", { name: "Save dashboard" })).toBeVisible();

  // Confirming goes back to a fresh screen.
  await startOver.click();
  await dialog.getByRole("button", { name: "Start over" }).click();
  await expect(preview.getByRole("button", { name: "Save dashboard" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Start from a template/ })).toBeVisible();
});

test("dashboard chat answers in the panel", async ({ page, request }) => {
  // A window that is not the dashboard's own, so the URL carries it (#366).
  await page.goto(
    `/dashboards/${await dashboardId(request, DEMO_DASHBOARD)}?from=now-2d&to=now`,
  );
  const launcher = page.getByRole("button", { name: "Ask about this dashboard" });
  await launcher.click();
  const chat = page.getByRole("dialog", { name: "Dashboard chat" });
  // Start clean: an earlier run's conversation is stored per person.
  const clear = chat.getByRole("button", { name: "Clear chat" });
  if (await clear.isVisible()) await clear.click();
  const suggestions = chat.getByRole("group", { name: "Suggested questions" });
  await expect(suggestions).toBeVisible();

  const sent = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith("/chat"),
  );
  await chat.getByRole("textbox", { name: "Message" }).fill("What is on this dashboard?");
  await chat.getByRole("button", { name: "Send" }).click();
  // The question carries the window on screen; the server resolves it.
  expect((await sent).postDataJSON().timeRange).toEqual({ from: "now-2d", to: "now" });
  await expect(chat.getByText(STUB_CHAT_REPLY)).toBeVisible();

  // Once a conversation has started, the suggestions are not offered again.
  await expect(suggestions).toHaveCount(0);
  await expect(chat.getByRole("button", { name: "Copy answer" })).toBeVisible();
  await expect(chat.getByRole("button", { name: "Try again" })).toBeVisible();

  // Escape closes it and hands focus back; C opens it again.
  await chat.getByRole("textbox", { name: "Message" }).press("Escape");
  await expect(chat).toHaveCount(0);
  await expect(launcher).toBeFocused();
  await page.keyboard.press("c");
  await expect(chat.getByText(STUB_CHAT_REPLY)).toBeVisible();

  // Clearing brings the suggestions back.
  await chat.getByRole("button", { name: "Clear chat" }).click();
  await expect(suggestions).toBeVisible();
  await chat.getByRole("button", { name: "Close chat" }).click();
  await expect(chat).toHaveCount(0);

  // "Ask about this panel" opens the chat on that panel, and sends only its id.
  const actions = page.getByRole("button", { name: /^Actions for / }).first();
  const title = ((await actions.getAttribute("aria-label")) ?? "").replace(
    /^Actions for /,
    "",
  );
  await actions.click();
  await page.getByRole("menuitem", { name: "Ask about this panel" }).click();
  await expect(chat.getByText(title, { exact: false }).first()).toBeVisible();
  const about = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith("/chat"),
  );
  await chat.getByRole("button", { name: /^Explain what / }).click();
  const body = (await about).postDataJSON();
  expect(typeof body.panelId).toBe("string");
  expect(JSON.stringify(body)).not.toMatch(/SELECT/i);
  await expect(chat.getByText(STUB_CHAT_REPLY)).toBeVisible();
  await chat.getByRole("button", { name: "Clear chat" }).click();
});

test("a deleted source tombstones the panels that used it", async ({ page, request }) => {
  const id = `e2e-gone-${Date.now().toString(36)}`;
  const name = `Doomed ${id}`;
  const created = await request.post("/api/sources", {
    data: {
      workspaceId: "demo",
      id,
      name,
      secretRef: "TS_METRICS",
      config: {
        host: "localhost",
        port: PG_PORT,
        database: "holotable",
        schema: "metrics",
        ssl: false,
        tables: [
          {
            name: "http_requests",
            timeField: "ts",
            columns: [
              { name: "ts", type: "timestamp with time zone" },
              { name: "route", type: "text" },
            ],
          },
        ],
      },
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const dash = await request.post("/api/dashboards", {
    data: {
      spec: {
        specVersion: SPEC_VERSION,
        title: `Uses ${id}`,
        timeRange: { from: "now-1h", to: "now" },
        refreshIntervalMs: 2000,
        panels: [
          {
            id: "routes",
            title: "Requests by route",
            viz: "table",
            query: {
              sourceId: id,
              sql: "SELECT route, count(*) AS n FROM http_requests GROUP BY route",
            },
            layout: { x: 0, y: 0, w: 12, h: 4 },
          },
        ],
      },
    },
  });
  expect(dash.ok(), await dash.text()).toBe(true);
  const { dashboard } = (await dash.json()) as { dashboard: { id: string } };

  await page.goto("/data-sources");
  await page.getByRole("button", { name: `Delete ${name}` }).click();
  const confirm = page.getByRole("dialog", { name: `Delete ${name}?` });
  await confirm.getByRole("button", { name: /^Delete/ }).click();
  await expect(page.locator(`#source-${id}`)).toBeHidden();

  await page.goto(`/dashboards/${dashboard.id}`);
  await expect(
    page.getByText("This panel's data source has been removed."),
  ).toBeVisible();
});

test("a panel link carries the window and picks to its target (#372)", async ({
  page,
  request,
}) => {
  const { source, target } = await createLinkedDashboards(request);
  await page.goto(`/dashboards/${source}?from=now-6h&to=now`);
  await waitForPanels(page);
  const panel = page.locator('[data-panel-id="routes"]');
  await expect(panel.getByText("Has links")).toBeAttached();
  const openMenu = async () => {
    await panel.getByRole("button", { name: "Actions for Requests by route" }).click();
    return page.getByRole("menu");
  };

  // A target that does not exist is a disabled item, never an href.
  let menu = await openMenu();
  const retired = menu.getByRole("menuitem", { name: /Retired dashboard/ });
  await expect(retired).toHaveAttribute("aria-disabled", "true");
  await expect(
    menu.locator('a[href*="00000000-0000-4000-8000-000000000000"]'),
  ).toHaveCount(0);

  // A self link sets the pick in place: same page, new URL.
  await menu.getByRole("menuitem", { name: "Only search" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/dashboards/${source}\\?.*var-route=%2Fsearch`),
  );

  // A link to the target carries the window, and its literal pick wins.
  menu = await openMenu();
  await menu.getByRole("menuitem", { name: "Checkout detail" }).click();
  await page.waitForURL(new RegExp(`/dashboards/${target}\\?`));
  const url = new URL(page.url());
  expect(url.searchParams.get("from")).toBe("now-6h");
  expect(url.searchParams.get("to")).toBe("now");
  expect(url.searchParams.getAll("var-route")).toEqual(["/checkout"]);
  await waitForPanels(page);
});

test.describe("as a viewer", () => {
  test.use({ storageState: storageStatePath("viewer") });

  test("the dashboard opens, the editor does not", async ({ page, request }) => {
    const id = await dashboardId(request, DEMO_DASHBOARD);
    await page.goto(`/dashboards/${id}`);
    await waitForPanels(page);
    await expect(page.getByRole("link", { name: "Edit" })).toHaveCount(0);

    // `notFound()` from the page: indistinguishable from a dashboard that
    // does not exist, by design. (Streamed, so the status line is already 200.)
    await page.goto(`/dashboards/${id}/edit`);
    await expect(
      page.getByRole("heading", { name: "This page could not be found." }),
    ).toBeVisible();
    await expect(page.locator("#p-title")).toHaveCount(0);
  });
});
