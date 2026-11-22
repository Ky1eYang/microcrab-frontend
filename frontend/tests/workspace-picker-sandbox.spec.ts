import { expect, test } from "@playwright/test";
import { actions, mount, picker } from "./workspace-picker-fixture";

/* Sandbox row states: every visible row selects (v0.1.20 contract: attach
 * then reports missing runtime files); Fetch/Retry prepare without selecting;
 * hidden when the browser lacks JSPI. */

test.describe("sandbox availability", () => {
  test("available: selectable row with description", async ({ page }) => {
    await mount(page, { sandbox: "available" });
    const row = page.locator('[data-host-flavor="browser_sandbox"]');
    await expect(row).toHaveAttribute("data-state", "ready");
    await expect(row).toHaveAccessibleName("沙盒");
    await expect(row).toHaveAccessibleDescription(
      "浏览器沙盒，提供虚拟文件、Shell 和 Python。",
    );
    await expect(
      page.locator('[data-host-flavor="chat_only"]'),
    ).toHaveAccessibleDescription(
      "可使用已授权的客户端工具和插件，不提供 Host 执行能力。",
    );
    await row.click();
    expect(await actions(page, "SelectDraftWorkspace")).toEqual([
      { type: "SelectDraftWorkspace", value: { kind: "browser_sandbox" } },
    ]);
  });

  test("not ready: the row still selects (v0.1.20) and keeps its hint", async ({
    page,
  }) => {
    await mount(page, { sandbox: "fetchable" });
    const row = page.locator('[data-host-flavor="browser_sandbox"]');
    await expect(row).toHaveAttribute("data-state", "not_ready");
    await expect(row).toContainText("运行时未就绪");
    await row.click();
    expect(await actions(page, "SelectDraftWorkspace")).toEqual([
      { type: "SelectDraftWorkspace", value: { kind: "browser_sandbox" } },
    ]);
  });

  test("not ready: Fetch prepares the runtime without selecting", async ({
    page,
  }) => {
    await mount(page, { sandbox: "fetchable" });
    const row = page.locator('[data-host-flavor="browser_sandbox"]');
    await page.getByTestId("picker-sandbox-fetch").click();
    await expect(row).toHaveAttribute("data-state", "ready");
    await expect(picker(page)).toBeVisible();
    expect(await actions(page, "SelectDraftWorkspace")).toEqual([]);
  });

  test("loading: spinner and busy, the row still selects", async ({ page }) => {
    await mount(page, { sandbox: "hold" });
    const row = page.locator('[data-host-flavor="browser_sandbox"]');
    await page.getByTestId("picker-sandbox-fetch").click();
    await expect(row).toHaveAttribute("data-state", "loading");
    await expect(row).toHaveAttribute("aria-busy", "true");
    await expect(row).toContainText("正在获取运行时…");
    await expect(picker(page)).toBeVisible();
    expect(await actions(page, "SelectDraftWorkspace")).toEqual([]);
    await row.click();
    expect(await actions(page, "SelectDraftWorkspace")).toEqual([
      { type: "SelectDraftWorkspace", value: { kind: "browser_sandbox" } },
    ]);
  });

  test("error: inline danger message and retry keep the picker open", async ({
    page,
  }) => {
    await mount(page, { sandbox: "missing" });
    const row = page.locator('[data-host-flavor="browser_sandbox"]');
    await page.getByTestId("picker-sandbox-fetch").click();
    await expect(row).toHaveAttribute("data-state", "error");
    const desc = row.locator(".picker-row-desc");
    await expect(desc).toContainText("无法获取运行时。");
    await expect(desc).toContainText(
      "浏览器 Host 运行时资源尚未安装或版本不兼容。",
    );
    const retry = page.getByTestId("picker-sandbox-retry");
    await expect(retry).toHaveText("重试");
    expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(32);
    await retry.click();
    await expect(row).toHaveAttribute("data-state", "error");
    await expect(picker(page)).toBeVisible();
    expect(await actions(page, "SelectDraftWorkspace")).toEqual([]);
  });

  test("hidden without JSPI: no sandbox row in the DOM, Chat Only stays", async ({
    page,
  }) => {
    await mount(page, { sandbox: "hidden" });
    await expect(page.locator('[data-host-flavor="chat_only"]')).toBeVisible();
    await expect(
      page.locator('[data-host-flavor="browser_sandbox"]'),
    ).toHaveCount(0);
  });
});
