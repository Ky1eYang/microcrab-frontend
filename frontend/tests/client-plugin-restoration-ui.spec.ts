import { maintainedPluginBundle } from "./plugin-bundle-fixture";
import { stateInspection } from "./state-inspection-fixture";
import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

for (const width of [1440, 390]) {
  test(`removed bundled Viewer stays removed until explicit import at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await nativeBackend(page);
    const index = await maintainedPluginBundle(page);
    const record = index.plugins.find(
      (entry) => entry.id === "microcrab.state-viewer",
    )!;
    await page.route("**/api/v1/sessions/s1/state/inspection", (route) =>
      route.fulfill({
        json: stateInspection({ mode: "reimported-viewer-fixture" }, {}),
      }),
    );
    await page.goto("/#/session/s1/plugins");
    const manager = page.getByTestId("client-plugins-manager");
    const viewer = manager.locator(
      'article[data-plugin-id="microcrab.state-viewer"]',
    );
    await manager
      .locator('[data-plugin-nav-id="microcrab.state-viewer"]')
      .click();
    await expect(viewer).toBeVisible();
    const bytes = await page.evaluate(
      async (file) =>
        Array.from(
          new Uint8Array(await (await fetch(`/plugins/${file}`)).arrayBuffer()),
        ),
      record.file,
    );
    await viewer.getByRole("button", { name: "移除", exact: true }).click();
    await expect(viewer).toHaveCount(0);
    await page.reload();
    await expect(manager).toBeVisible();
    await expect(manager.getByTestId("plugins-restore-bundled")).toHaveCount(0);
    await expect(
      manager.locator('[data-plugin-nav-id="microcrab.state-viewer"]'),
    ).toHaveCount(0);
    await manager
      .getByTestId("plugin-upload")
      .setInputFiles({
        name: "state-viewer.wasm",
        mimeType: "application/wasm",
        buffer: Buffer.from(bytes),
      });
    await expect(viewer).toHaveAttribute("data-status", "disabled");
    await viewer.getByLabel("在当前会话启用").check();
    await expect(viewer).toHaveAttribute("data-status", "ready");
    await expect(
      viewer.getByRole("button", { name: "展开", exact: true }),
    ).toHaveCount(0);
    await viewer.getByLabel("在当前会话启用").uncheck();
    await expect(viewer.getByLabel("在当前会话启用")).not.toBeChecked();
    await expect(manager).toHaveAttribute("aria-busy", "false");
    await page.reload();
    await manager
      .locator('[data-plugin-nav-id="microcrab.state-viewer"]')
      .click();
    await expect(viewer).toHaveAttribute("data-status", "disabled");
    await expect(viewer.getByLabel("在当前会话启用")).not.toBeChecked();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });
}
