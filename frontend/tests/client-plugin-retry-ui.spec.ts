import { selectSidebarPlugin } from "./plugin-sidebar-selection";
import { maintainedPluginBundle } from "./plugin-bundle-fixture";
import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

test.beforeEach(async ({ page }) => {
  await maintainedPluginBundle(page);
});

test("bound button icons and pressed states validate without allowing arbitrary projected values", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/src/plugins/schema.ts";
    const { validateTree, validateProjection } = await import(path);
    const tree = {
      type: "button",
      props: { icon: { $ref: "icon" }, pressed: { $ref: "pressed" } },
    };
    validateTree(tree);
    validateProjection(tree, { icon: "eye-off", pressed: true });
    const failures: string[] = [];
    for (const vars of [
      { icon: "arbitrary", pressed: true },
      { icon: "eye", pressed: "yes" },
    ]) {
      try {
        validateProjection(tree, vars);
      } catch (error) {
        failures.push(String(error));
      }
    }
    try {
      validateTree({ type: "button", props: { pressed: "yes" } });
    } catch (error) {
      failures.push(String(error));
    }
    return failures;
  });
  expect(result).toHaveLength(3);
  expect(result[0]).toContain("unsupported resolved node icon");
  expect(result[1]).toContain("resolved node pressed must be boolean");
  expect(result[2]).toContain("node pressed must be boolean or reference");
});

test("fault recovery reloads without deleting plugin data and disabled/missing surfaces offer management", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.route("**/src/main.tsx", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `import { AppStore as RecoveryUIStore } from '/src/state/store.ts';
const recoveryUIStart = RecoveryUIStore.prototype.start;
RecoveryUIStore.prototype.start = function () { window.recoveryUIStore = this; return recoveryUIStart.call(this); };
${await response.text()}`,
    });
  });
  await page.goto("/#/session/s1/plugins");
  const manager = page.getByTestId("client-plugins-manager");
  await manager.locator('[data-plugin-nav-id="microcrab.fixture"]').click();
  const fixture = manager.locator(
    'article[data-plugin-id="microcrab.fixture"]',
  );
  await fixture.getByLabel("在当前会话启用").click();
  await expect(fixture.getByLabel("在当前会话启用")).toBeChecked();
  await expect(fixture).toHaveAttribute("data-status", "ready");
  await page.goto("/#/session/s1");
  const sidebar = page.getByTestId("client-plugin-sidebar");
  if (!(await sidebar.isVisible()))
    await page.locator(".header-right-toggle-btn").click();
  await selectSidebarPlugin(sidebar, "Component fixture");
  await sidebar.getByTestId("plugin-expand").click();
  const surface = page.getByTestId("expanded-plugin-page");
  await expect(
    surface.getByRole("button", { name: "Increment", exact: true }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const registry = (window as any).recoveryUIStore.plugins.registry;
    await registry.store.writeKV(
      "microcrab.fixture",
      "recovery-sentinel",
      "keep original",
      new AbortController().signal,
    );
    registry.setVariable("microcrab.fixture", "invalid.callback", undefined);
  });
  await expect(surface.getByTestId("plugin-retry")).toBeVisible();
  await surface.getByTestId("plugin-retry").click();
  await expect(
    surface.getByRole("button", { name: "Increment", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(async () =>
      (window as any).recoveryUIStore.plugins.registry.store.kv(
        "microcrab.fixture",
      ),
    ),
  ).toEqual({ "recovery-sentinel": "keep original" });
  await page.evaluate(async () => {
    await (window as any).recoveryUIStore.plugins.registry.setEnabled(
      "microcrab.fixture",
      "s1",
      false,
    );
  });
  await expect(
    surface.getByText("当前会话已禁用此插件。", { exact: true }),
  ).toBeVisible();
  await expect(surface.getByTestId("plugin-retry")).toHaveCount(0);
  await page.evaluate(async () => {
    await (window as any).recoveryUIStore.plugins.registry.remove(
      "microcrab.fixture",
    );
  });
  await expect(
    surface.getByText("此插件已不再安装。", { exact: true }),
  ).toBeVisible();
  await expect(surface.getByTestId("plugin-retry")).toHaveCount(0);
  await surface.getByRole("button", { name: "管理", exact: true }).click();
  await expect(page.getByTestId("client-plugins-manager")).toBeVisible();
  await expect(
    page
      .getByTestId("client-plugins-manager")
      .getByTestId("plugins-restore-bundled"),
  ).toHaveCount(0);
});
