import { maintainedPluginBundle } from "./plugin-bundle-fixture";
import { stateInspection } from "./state-inspection-fixture";
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { nativeBackend } from "./native-fixture";
import { connectHostUI } from "./host-fixture";

for (const width of [1440, 390]) {
  test(`plugin inspection and management preserve the conversation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await nativeBackend(page);
  await maintainedPluginBundle(page);
    await page.route("**/api/v1/sessions/s1/state/inspection", (route) =>
      route.fulfill({
        json: stateInspection(
          {
            project: "workspace-inspector-fixture",
            hidden: "owner-original",
          },
          {
            project: { visibility: "visible", persistence: "persisted" },
            hidden: { visibility: "invisible", persistence: "persisted" },
          },
        ),
      }),
    );

    await page.goto("/#/session/s1");
    await connectHostUI(page);
    const composer = page.getByTestId("composer").locator("textarea");
    await expect(composer).toBeEnabled();
    await composer.fill("preserved workspace draft");
    const route = page.url();
    await composer.evaluate((element) =>
      element.setAttribute("data-preserved-instance", "yes"),
    );
    await page.locator(".header-right-toggle-btn").click();
    const sidebar = page.getByTestId("client-plugin-sidebar");
    await expect(
      sidebar.getByText("workspace-inspector-fixture", { exact: false }),
    ).toBeVisible();
    const geometry = await sidebar.evaluate((element) => {
      const panel = element
        .querySelector(".client-plugin-panel")!
        .getBoundingClientRect();
      const root = element.getBoundingClientRect();
      const body = element
        .querySelector(".payload-body")!
        .getBoundingClientRect();
      return {
        unused: root.bottom - panel.bottom,
        body: body.height,
        available: panel.height,
      };
    });
    expect(geometry.unused).toBeLessThan(4);
    expect(geometry.body).toBeGreaterThan(320);
    await sidebar.getByTestId("plugin-expand").click();
    const dialog = page.getByTestId("content-dialog");
    await expect(
      page
        .getByTestId("expanded-plugin-page")
        .getByText("workspace-inspector-fixture", { exact: false }),
    ).toBeVisible();
    expect(page.url()).toBe(route);
    await expect(composer).toHaveAttribute("data-preserved-instance", "yes");
    await expect(composer).toHaveValue("preserved workspace draft");
    await expect(dialog).toHaveAttribute("data-layout", "workspace");
    await dialog
      .getByRole("button", { name: /^显示模型不可见的值/, pressed: false })
      .click();
    await expect(
      dialog.getByText("owner-original", { exact: false }),
    ).toBeVisible();
    await page.screenshot({
      path: `test-results/visual/client-plugin-workspace-dialog-${width}.png`,
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(sidebar.getByTestId("plugin-expand")).toBeFocused();
    await expect(sidebar).toBeVisible();
    await page.screenshot({
      path: `test-results/visual/client-plugin-workspace-sidebar-${width}.png`,
      fullPage: true,
    });
    await sidebar.getByTestId("plugins-manage").click();
    const manager = page.getByTestId("client-plugins-manager");
    await expect(manager).toBeVisible();
    await expect(page).toHaveURL(/#\/session\/s1\/plugins$/);
    await expect(composer).toHaveAttribute("data-preserved-instance", "yes");
    await expect(composer).toBeHidden();
    await expect(page.getByTestId("content-dialog")).toHaveCount(0);
    await manager.getByTestId("plugin-upload").setInputFiles({
      name: "plain-core.wasm",
      mimeType: "application/wasm",
      buffer: Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
    });
    await expect(manager.getByRole("alert")).toContainText(
      "缺少插件 WIT 元数据",
    );
    const viewer = manager.locator('article[data-plugin-id="microcrab.state-viewer"]');
    await manager.locator('[data-plugin-nav-id="microcrab.state-viewer"]').click();
    const bytes = await readFile(
      process.env.MICROCRAB_TEST_VIEWER_CORE_WASM ??
        "../target/wasm32-unknown-unknown/release/microcrab_client_plugin_state_viewer.wasm",
    );
    const upload = {
      name: "microcrab_client_plugin_state_viewer.wasm",
      mimeType: "application/wasm",
      buffer: bytes,
    };
    await manager.getByTestId("plugin-upload").setInputFiles(upload);
    await expect(manager.getByRole("alert")).toContainText("此插件已安装");
    await viewer.locator('input[type="file"]').setInputFiles(upload);
    await expect(
      manager.getByText("已将 Rust WASM 自动封装为客户端组件并导入。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(viewer.getByLabel("在当前会话启用")).toBeChecked();
    await expect(viewer).toHaveAttribute("data-status", "ready");
    await viewer.getByRole("button", { name: "移除", exact: true }).click();
    await expect(viewer).toHaveCount(0);
    await manager.getByTestId("plugin-upload").setInputFiles({
      name: "microcrab_client_plugin_state_viewer.wasm",
      mimeType: "application/wasm",
      buffer: bytes,
    });
    await expect(
      manager.getByText("已将 Rust WASM 自动封装为客户端组件并导入。", {
        exact: true,
      }),
    ).toBeVisible({ timeout: 20000 });
    await viewer.getByLabel("在当前会话启用").check();
    await expect(viewer).toHaveAttribute("data-status", "ready");
    await page.screenshot({
      path: `test-results/visual/client-plugin-workspace-manager-${width}.png`,
      fullPage: true,
    });
    await manager.getByRole("button", { name: "返回", exact: true }).click();
    await expect(manager).toHaveCount(0);
    await expect(composer).toHaveValue("preserved workspace draft");
    await expect(composer).toHaveAttribute("data-preserved-instance", "yes");
    expect(page.url()).toBe(route);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
  });
}
