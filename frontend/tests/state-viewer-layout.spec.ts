import { maintainedPluginBundle } from "./plugin-bundle-fixture";
import { stateInspection } from "./state-inspection-fixture";
import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

for (const width of [1015, 1100, 900, 390]) {
  test(`plugin rail remains readable and locally closable at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await nativeBackend(page);
  await maintainedPluginBundle(page);
    await page.route("**/api/v1/sessions/s1/state/inspection", (route) =>
      route.fulfill({
        json: stateInspection(
          {
            session: { epoch: 3, turn: 4, round: 2 },
            mode: "execute",
            workspace: "controlled-workspace",
          },
          {},
        ),
      }),
    );

    await page.goto("/#/session/s1");
    await page.locator(".header-right-toggle-btn").click();
    const rail = page.getByRole("complementary", { name: "Plugins" });
    await expect(rail).toBeVisible();
    await expect(rail.getByText('"execute"', { exact: false })).toBeVisible();
    await expect
      .poll(async () => (await rail.boundingBox())?.width ?? 0)
      .toBeGreaterThanOrEqual(280);
    if (width >= 1000) {
      await expect(page.locator(".shell")).toHaveAttribute(
        "data-left-collapsed",
        "true",
      );
      const splitter = rail.getByRole("separator");
      const before = (await rail.boundingBox())!.width;
      await splitter.focus();
      await splitter.press("ArrowRight");
      await expect
        .poll(async () => (await rail.boundingBox())!.width)
        .toBeLessThan(before);
      const start = (await splitter.boundingBox())!;
      const resizeBefore = (await rail.boundingBox())!.width;
      await page.mouse.move(start.x + 3, start.y + 120);
      await page.mouse.down();
      await page.mouse.move(start.x + 20, start.y + 120);
      await page.mouse.up();
      await expect
        .poll(async () => (await rail.boundingBox())!.width)
        .toBeLessThan(resizeBefore);
    } else {
      await expect(rail).toHaveAttribute("data-overlay", "true");
      await expect(page.getByTestId("right-rail-backdrop")).toBeVisible();
    }
    await page.screenshot({
      path: `test-results/visual/state-viewer-governed-readable-sidebar-${width}.png`,
      fullPage: true,
    });
    await rail.getByTestId("right-rail-close").click();
    await expect(rail).toHaveCount(0);
    await expect(page.locator(".header-right-toggle-btn")).toBeFocused();
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

for (const entry of ["sidebar", "direct"] as const) {
test(`expanded Viewer via ${entry} fetches full framework State and hides initial empty payload`, async ({
  page,
}) => {
  await nativeBackend(page);
  await maintainedPluginBundle(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  await page.route("**/api/v1/sessions/s1/state/inspection", async (route) => {
    reads++;
    await gate;
    await route.fulfill({
      json: stateInspection(
        {
          session: { epoch: 7, turn: 12, round: 3 },
          mode: "execute",
          limits: { max_processes: 16 },
          workspace: "framework-state-fixture",
        },
        {},
      ),
    });
  });

  if (entry === "sidebar") {
    await page.goto("/#/session/s1");
    await page.locator(".header-right-toggle-btn").click();
    const sidebar = page.getByTestId("client-plugin-sidebar");
    await sidebar.getByRole("tab", { name: "State Viewer", exact: true }).click();
    await sidebar.getByTestId("plugin-expand").click();
  } else {
    await page.goto("/#/session/s1/plugins/microcrab.state-viewer");
    await expect(page.getByTestId("client-plugin-sidebar")).toHaveCount(0);
  }
  const expanded = page.getByTestId("expanded-plugin-page");
  await expect.poll(() => reads).toBeGreaterThan(0);
  await expect(
    expanded.getByText("正在读取状态…", { exact: true }),
  ).toBeVisible();
  await expect(expanded.locator(".payload")).toHaveCount(0);
  release();
  await expect(
    expanded.getByText("framework-state-fixture", { exact: false }),
  ).toBeVisible();
  await expect(expanded.locator(".payload-body")).toContainText('"turn": 12');
  await expect(expanded.locator(".payload-body")).toContainText(
    '"max_processes": 16',
  );

  await expect(
    expanded.getByText("正在读取状态…", { exact: true }),
  ).toHaveCount(0);
  const search = expanded.getByRole("searchbox");
  await search.fill("unmatched-query");
  await expect(expanded.locator(".content-viewer-pre")).toHaveText("{}");
  await expect(expanded.getByTestId("content-viewer-edit")).toBeVisible();
  await expanded.getByRole("button", { name: "清除搜索", exact: true }).click();
  await expect(search).toHaveValue("");
  await expect(
    expanded.getByText("framework-state-fixture", { exact: false }),
  ).toBeVisible();
  await page.screenshot({
    path: `test-results/visual/state-viewer-governed-full-state-expanded-${entry}.png`,
    fullPage: true,
  });
});
}
