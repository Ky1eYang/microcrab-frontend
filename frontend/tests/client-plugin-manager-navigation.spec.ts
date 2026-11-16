import { maintainedPluginBundle } from "./plugin-bundle-fixture";
import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { connectHostUI } from "./host-fixture";
import { stateInspection } from "./state-inspection-fixture";

for (const width of [1440, 390]) {
  test(`dedicated plugin navigation retains draft and conversation DOM at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const backend = await nativeBackend(page);
    await maintainedPluginBundle(page);
    await page.route("**/api/v1/sessions/s1/state/inspection", (route) =>
      route.fulfill({ json: stateInspection({ sample: "settings-view" }, {}) }),
    );
    await page.goto("/#/session/s1");
    await connectHostUI(page);
    const composer = page.getByTestId("composer").locator("textarea");
    await expect(composer).toBeEnabled();
    await composer.fill("draft survives dedicated plugin navigation");
    await composer.evaluate((element) =>
      element.setAttribute("data-retained", "original"),
    );
    backend.finish(Array.from({ length: 80 }, (_, index) => `Reading paragraph ${index}: preserved transcript position.`).join("\n\n"));
    const transcript = page.locator("#conversation-transcript");
    await expect.poll(() => transcript.evaluate(element => element.scrollHeight)).toBeGreaterThan(1200);
    await transcript.hover();
    const beforeReading = await transcript.evaluate(element => element.scrollTop);
    await page.mouse.wheel(0, -600);
    await expect(transcript).toHaveAttribute("data-following", "false");
    await expect.poll(() => transcript.evaluate(element => element.scrollTop)).toBeLessThan(beforeReading - 500);
    const readingPosition = await transcript.evaluate(element => element.scrollTop);
    const nav = page.getByTestId("rail-plugins-btn").filter({ visible: true });
    await nav.focus();
    await page.keyboard.press("Enter");
    const manager = page.getByTestId("client-plugins-manager");
    await expect(manager).toBeVisible();
    await expect(manager.getByRole("searchbox")).toBeFocused();
    await expect(page).toHaveURL(/\/session\/s1\/plugins$/);
    await expect(page.getByTestId("plugin-workspace-dialog")).toHaveCount(0);
    await expect(composer).toBeHidden();
    await expect(page.locator(".retained-conversation-page .floating-scroll-bottom")).toBeHidden();
    await expect(composer).toHaveAttribute("data-retained", "original");
    await manager.getByRole("searchbox").fill("no-such-plugin-123");
    await expect(manager.getByTestId("plugin-nav-item")).toHaveCount(1);
    await expect(
      manager.getByText(
        "当前所选插件不符合筛选条件，仍保留在下方以保护设置草稿。",
      ),
    ).toBeVisible();
    // Filtering never silently replaces the currently inspected plugin.
    await expect(manager.getByTestId("plugin-entry")).toHaveCount(1);
    await manager.getByRole("button", { name: "清除插件搜索" }).click();
    await expect(manager.getByTestId("plugin-nav-item").first()).toBeVisible();
    await expect(manager.getByTestId("plugins-restore-bundled")).toHaveCount(0);
    await manager
      .locator('[data-plugin-nav-id="microcrab.state-viewer"]')
      .click();
    await expect(manager.getByTestId("plugin-setting-surface")).toContainText("settings-view");
    for (const theme of width === 1440
      ? (["light", "dark"] as const)
      : (["light"] as const)) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.screenshot({
        path: `../../temp/v0.1.18-plugin-manager-${width}-${theme}.png`,
        fullPage: true,
        animations: "disabled",
      });
    }
    await manager.getByRole("button", { name: "返回", exact: true }).click();
    await expect(composer).toBeVisible();
    await expect(nav).toBeFocused();
    await expect(transcript).toHaveAttribute("data-following", "false");
    await expect.poll(() => transcript.evaluate(element => element.scrollTop)).toBeCloseTo(readingPosition, 0);
    await expect(composer).toHaveAttribute("data-retained", "original");
    await expect(composer).toHaveValue(
      "draft survives dedicated plugin navigation",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("projectless manager browser Back and Forward follow home without Session state", async ({ page }) => {
  await nativeBackend(page);
  await maintainedPluginBundle(page);
  await page.goto("/#/");
  const nav = page.getByTestId("rail-plugins-btn").filter({ visible: true });
  await nav.focus();
  await page.keyboard.press("Enter");
  const manager = page.getByTestId("client-plugins-manager");
  await expect(manager).toBeVisible();
  await page.goBack();
  await expect(manager).toHaveCount(0);
  await expect(nav).toBeFocused();
  await expect(page.locator(".header-right-toggle-btn")).toHaveCount(0);
  await page.goForward();
  await expect(manager).toBeVisible();
  await expect(manager.getByRole("searchbox")).toBeFocused();
  await expect(page.locator(".header-right-toggle-btn")).toHaveCount(0);
});

test("sidebar management keyboard entry focuses manager and return uses visible navigation fallback", async ({ page }) => {
  await nativeBackend(page);
  await maintainedPluginBundle(page);
  await page.route("**/api/v1/sessions/s1/state/inspection", route => route.fulfill({ json: stateInspection({ sample: "focus-test" }, {}) }));
  await page.goto("/#/session/s1");
  await page.locator(".header-right-toggle-btn").click();
  const manage = page.getByTestId("plugins-manage");
  await manage.focus();
  await page.keyboard.press("Enter");
  const manager = page.getByTestId("client-plugins-manager");
  await expect(manager.getByRole("searchbox")).toBeFocused();
  await manager.getByRole("button", { name: "返回", exact: true }).click();
  await expect(manager).toHaveCount(0);
  await expect(page.getByTestId("rail-plugins-btn").filter({ visible: true })).toBeFocused();
});

test("no-session State Viewer settings explain Session requirement without inspecting state", async ({
  page,
}) => {
  await nativeBackend(page);
  await maintainedPluginBundle(page);
  let stateRequests = 0;
  await page.route("**/state/inspection", (route) => {
    stateRequests++;
    return route.abort();
  });
  await page.goto("/#/plugins");
  const manager = page.getByTestId("client-plugins-manager");
  await expect(manager).toBeVisible();
  await manager
    .locator('[data-plugin-nav-id="microcrab.state-viewer"]')
    .click();
  await expect(manager.getByTestId("plugin-setting-surface")).toContainText(
    /Session|会话/,
  );
  await expect(manager.getByTestId("plugin-setting-surface")).not.toContainText(
    /state-inspection requires/,
  );
  expect(stateRequests).toBe(0);
  await expect(page.locator(".header-right-toggle-btn")).toHaveCount(0);
});
