import { maintainedPluginBundle } from "./plugin-bundle-fixture";
import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { selectSidebarPlugin } from "./plugin-sidebar-selection";

/** No development source imports: this exercises emitted Worker, Component and shim. */
test("emitted native and HTML fixture surfaces mount, act and switch without replacing the conversation", async ({
  page,
}) => {
  await nativeBackend(page);
  await maintainedPluginBundle(page);
  await page.addInitScript(() =>
    localStorage.setItem("microcrab.ui.rightRailCollapsed", "false"),
  );
  await page.goto("/#/session/s1/plugins");
  const manager = page.getByTestId("client-plugins-manager");
  await expect(manager).toBeVisible();
  await manager.locator('[data-plugin-nav-id="microcrab.fixture"]').click();
  const fixture = manager.locator(
    'article[data-plugin-id="microcrab.fixture"]',
  );
  await expect(fixture).toBeVisible();
  const enabled = fixture.getByLabel("在当前会话启用");
  await enabled.click();
  await expect(enabled).toBeChecked();
  await expect(fixture).toHaveAttribute("data-status", "ready");
  await page.goto("/#/session/s1");
  const message = page
    .getByTestId("chat-message")
    .filter({ hasText: "历史提问" });
  await expect(message).toBeVisible();
  await message.evaluate((node) =>
    node.setAttribute("data-production-survivor", "yes"),
  );
  const route = page.url();
  const sidebar = page.getByTestId("client-plugin-sidebar");
  await selectSidebarPlugin(sidebar, "Component fixture");
  await sidebar.getByRole("button", { name: "Increment", exact: true }).click();
  await expect(sidebar.getByText("1", { exact: true })).toBeVisible();
  await sidebar.getByRole("button", { name: "Use HTML", exact: true }).click();
  const html = sidebar.getByTestId("plugin-webview");
  await expect(html).toHaveAttribute("data-status", "ready");
  await expect(html).toHaveAttribute("sandbox", "allow-scripts");
  const frame = html.contentFrame();
  await frame
    .getByRole("button", { name: "Fixture HTML", exact: true })
    .click();
  await expect(frame.locator("#fixture-count")).toHaveText("2");
  await sidebar.getByTestId("plugin-expand").click();
  const expanded = page.getByTestId("expanded-plugin-page");
  const expandedHtml = expanded.getByTestId("plugin-webview");
  await expect(expandedHtml).toHaveAttribute("data-status", "ready");
  await expandedHtml
    .contentFrame()
    .getByRole("button", { name: "Fixture HTML", exact: true })
    .click();
  await expect(
    expandedHtml.contentFrame().locator("#fixture-count"),
  ).toHaveText("3");
  await page
    .getByTestId("content-dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  expect(page.url()).toBe(route);
  await page
    .getByTestId("session-plugin-tab")
    .filter({ hasText: "Component fixture" })
    .click();
  const session = page.getByTestId("session-plugin-panel");
  const sessionHtml = session.getByTestId("plugin-webview");
  await expect(sessionHtml).toHaveAttribute("data-status", "ready");
  await sessionHtml
    .contentFrame()
    .getByRole("button", { name: "Use native", exact: true })
    .click();
  await expect(sessionHtml).toHaveCount(0);
  await expect(
    session.getByRole("button", { name: "Increment", exact: true }),
  ).toBeVisible();
  await expect(message).toHaveAttribute("data-production-survivor", "yes");
  expect(page.url()).toBe(route);
});
