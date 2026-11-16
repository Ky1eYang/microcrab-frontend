import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { nativeBackend } from "./native-fixture";
import { stateInspection } from "./state-inspection-fixture";

// Consume the real assembled public index and immutable Components. No maintained
// guest fixture replaces the Zig artifact being accepted in these cases.
const index = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../public/plugins/current.json"),
    "utf8",
  ),
);
const current = index.plugins.find(
  (plugin: any) => plugin.id === "microcrab.state-viewer",
);
const previous =
  "2f009381f99caf9a76ceb0797085c9de4e400688ab6283ad2b4135ccf86dad80";

async function openSidebar(page: Page) {
  await page.goto("/#/session/s1");
  const sidebar = page.getByTestId("client-plugin-sidebar");
  if (!(await sidebar.isVisible()))
    await page.locator(".header-right-toggle-btn").click();
  await sidebar.getByRole("tab", { name: "State Viewer", exact: true }).click();
  const webview = sidebar.getByTestId("plugin-webview");
  await expect(webview).toHaveAttribute("data-status", "ready");
  return webview;
}

async function setup(page: Page) {
  await nativeBackend(page, { selectProject: false });
  let reads = 0;
  await page.route("**/api/v1/sessions/s1/state/inspection", (route) => {
    reads++;
    return route.fulfill({
      json: stateInspection(
        { owned: { before: true } },
        { owned: { visibility: "visible", persistence: "persisted" } },
      ),
    });
  });
  await page.addInitScript(() => {
    if (window === window.top)
      localStorage.setItem("microcrab.ui.theme", "dark");
  });
  return () => reads;
}

test("assembled State Viewer follows the packaged host theme and retains its editor on a live switch", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await setup(page);
  const actualIndex = await page.request.get("/plugins/current.json");
  expect(await actualIndex.json()).toEqual(index);
  const webview = await openSidebar(page);
  const frame = webview.contentFrame();
  await expect(frame.locator("html")).toHaveAttribute("data-theme", "dark");
  const hostBackground = await page
    .locator("html")
    .evaluate((root) => getComputedStyle(root).getPropertyValue("--bg").trim());
  await expect(frame.locator("body")).toHaveCSS(
    "background-color",
    "rgb(31, 31, 31)",
  );
  expect(hostBackground).toBe("#1f1f1f");
  await expect(frame.locator(".var-card")).toContainText("owned");
  await page.screenshot({
    path: info.outputPath("packaged-state-viewer-dark.png"),
    fullPage: true,
  });
  await frame.locator(".op-edit").click();
  await frame.locator("#modal-val").fill('{"unsaved":true}');
  const documentSource = await webview.getAttribute("srcdoc");
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  await expect(frame.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(frame.locator("body")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await expect(frame.locator("#modal-val")).toHaveValue('{"unsaved":true}');
  expect(await webview.getAttribute("srcdoc")).toBe(documentSource);
  await page.screenshot({
    path: info.outputPath("packaged-state-viewer-light.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("assembled exact predecessor upgrades without resetting choices and manager never inspects State", async ({
  page,
}) => {
  const reads = await setup(page);
  expect(current.supersedes).toContain(previous);
  await page.route("**/plugins/current.json", (route) =>
    route.fulfill({
      json: {
        ...index,
        plugins: index.plugins.map((plugin: any) =>
          plugin.id === current.id
            ? {
                ...plugin,
                sha256: previous,
                file: `${plugin.id}/${previous}/plugin.wasm`,
              }
            : plugin,
        ),
      },
    }),
  );
  await page.goto("/#/session/s1/plugins");
  const manager = page.getByTestId("client-plugins-manager");
  await manager.locator(`[data-plugin-nav-id="${current.id}"]`).click();
  const viewer = manager.locator(`article[data-plugin-id="${current.id}"]`);
  await expect(viewer).toHaveAttribute("data-status", "ready");
  await expect(viewer.locator(".client-plugin-hash-value")).toHaveText(
    previous,
  );
  await viewer.getByLabel("优先级", { exact: true }).fill("7");
  await expect(manager).toHaveAttribute("aria-busy", "false");
  await viewer.getByLabel("新会话默认启用", { exact: true }).click();
  await expect(
    viewer.getByLabel("新会话默认启用", { exact: true }),
  ).not.toBeChecked();
  await expect(manager).toHaveAttribute("aria-busy", "false");
  await expect(
    viewer.getByLabel("在当前会话启用", { exact: true }),
  ).toBeChecked();
  await page.unroute("**/plugins/current.json");
  await page.reload();
  await manager.locator(`[data-plugin-nav-id="${current.id}"]`).click();
  await expect(viewer).toHaveAttribute("data-status", "ready");
  await expect(viewer.locator(".client-plugin-hash-value")).toHaveText(
    current.sha256,
  );
  await expect(viewer.getByLabel("优先级", { exact: true })).toHaveValue("7");
  await expect(
    viewer.getByLabel("新会话默认启用", { exact: true }),
  ).not.toBeChecked();
  await expect(
    viewer.getByLabel("在当前会话启用", { exact: true }),
  ).toBeChecked();
  await expect(manager.getByTestId("plugin-webview")).toHaveCount(0);
  await expect(manager.getByTestId("plugins-restore-bundled")).toHaveCount(0);
  await expect(
    viewer.getByRole("button", { name: "展开", exact: true }),
  ).toHaveCount(0);
  expect(reads()).toBe(0);
  await expect(viewer.locator(".client-plugin-import-list li")).toHaveCount(3);
  const webview = await openSidebar(page);
  await expect(webview.contentFrame().locator("body")).toHaveCSS(
    "background-color",
    "rgb(31, 31, 31)",
  );
});
