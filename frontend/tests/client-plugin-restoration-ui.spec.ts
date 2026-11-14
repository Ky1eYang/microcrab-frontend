import { stateInspection } from "./state-inspection-fixture";
import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

for (const width of [1440, 390]) {
  test(`removed bundled Viewer can be explicitly restored without file upload at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await nativeBackend(page);
    await page.route("**/api/v1/sessions/s1/state/inspection", (route) =>
      route.fulfill({
        json: stateInspection(
          { session: { turn: 5 }, mode: "restored-viewer-fixture" },
          {},
        ),
      }),
    );

    await page.goto("/#/session/s1/plugins");
    const manager = page.getByTestId("client-plugins-manager");
    const viewer = manager.locator('[data-plugin-id="microcrab.state-viewer"]');
    await expect(viewer).toBeVisible();
    await viewer.getByRole("button", { name: "移除", exact: true }).click();
    await expect(viewer).toHaveCount(0);
    await page.reload();
    await expect(manager).toBeVisible();
    await expect(viewer).toHaveCount(0);
    await manager.getByTestId("plugins-restore-bundled").click();
    await expect(viewer).toHaveAttribute("data-status", "ready", {
      timeout: 20_000,
    });
    await expect(viewer.getByLabel("在当前会话启用")).toBeChecked();
    await expect(manager.getByText(/已恢复 .* 个预置插件/)).toBeVisible();
    await viewer.getByRole("button", { name: "展开", exact: true }).click();
    await expect(
      page
        .getByTestId("expanded-plugin-page")
        .getByText("restored-viewer-fixture", { exact: false }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await viewer.getByLabel("在当前会话启用").uncheck();
    await manager.getByTestId("plugins-restore-bundled").click();
    await expect(
      manager.getByText("当前预置插件均已安装，已有数据和启用设置未更改。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(viewer.getByLabel("在当前会话启用")).not.toBeChecked();
    await viewer.getByRole("button", { name: "展开", exact: true }).click();
    const expanded = page.getByTestId("expanded-plugin-page");
    await expect(
      expanded.getByText("当前会话已禁用此插件。", { exact: true }),
    ).toBeVisible();
    await expect(expanded.getByTestId("plugin-retry")).toHaveCount(0);
    await expect(
      expanded.getByRole("button", { name: "管理", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.screenshot({
      path: `test-results/visual/client-plugin-restoration-manager-${width}.png`,
      fullPage: true,
    });
    await page.reload();
    await expect(viewer).toHaveAttribute("data-status", "disabled");
    await expect(viewer.getByLabel("在当前会话启用")).not.toBeChecked();
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
