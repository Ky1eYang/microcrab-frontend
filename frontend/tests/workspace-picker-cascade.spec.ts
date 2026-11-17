import { expect, test } from "@playwright/test";
import { actions, mount, picker } from "./workspace-picker-fixture";

/* Workspace picker P1 (v0.1.18): one column with pinned search, Recent (5),
 * "All projects (N)", Other workspaces and a pinned New project. The former
 * cascading Host flyout no longer exists. */

test("default view: Recent (5), All projects (N) by name, back, no Host flyout", async ({
  page,
}) => {
  await mount(page);
  await expect(page.getByRole("searchbox")).toBeFocused();
  const recent = page
    .getByTestId("picker-recent")
    .getByTestId("home-project-item");
  await expect(recent).toHaveCount(5);
  await expect(recent.first()).toHaveAttribute("data-project-id", "p0");
  await expect(page.getByTestId("picker-host-submenu")).toHaveCount(0);
  await expect(page.locator("[data-host-id]")).toHaveCount(0);
  const all = page.getByTestId("picker-all-projects");
  await expect(all).toHaveText(/全部项目 \(18\)/);
  // Offline stays visible; unknown is not repeated on every row.
  await expect(
    picker(page).locator('[data-project-id="p4"] .picker-project-status'),
  ).toHaveText("离线");
  await all.click();
  await expect(picker(page)).toHaveAttribute("data-view", "all");
  const back = page.getByTestId("picker-all-back");
  await expect(back).toHaveText("全部项目 · 按名称 (18)");
  await expect(back).toHaveCSS("position", "sticky");
  const ids = await picker(page)
    .locator('[data-testid="picker-all"] [data-project-id]')
    .evaluateAll((rows) =>
      rows.map((row) => (row as HTMLElement).dataset.projectId),
    );
  expect(ids).toHaveLength(18);
  // Name order in the current locale, numeric-aware: Project 2 before 10.
  expect(ids.indexOf("p2")).toBeLessThan(ids.indexOf("p10"));
  expect(ids.indexOf("p9")).toBeLessThan(ids.indexOf("p10"));
  expect(ids.indexOf("p1")).toBeLessThan(ids.indexOf("p2"));
  // Unassigned Host fallback instead of a raw identity.
  await expect(
    picker(page).locator('[data-project-id="p17"] .picker-row-sub'),
  ).toHaveText("未分配 Host");
  await picker(page)
    .locator('[data-project-id="p16"]')
    .scrollIntoViewIfNeeded();
  await expect(back).toBeInViewport();
  await back.click();
  await expect(picker(page)).toHaveAttribute("data-view", "default");
  await expect(page.getByTestId("picker-other-workspaces")).toBeVisible();
  await expect(page.getByTestId("picker-create-project")).toBeVisible();
});

test("search highlights matches, counts them, keyboard moves and Enter selects", async ({
  page,
}) => {
  await mount(page);
  const search = page.getByRole("searchbox");
  await search.fill("tree-1");
  await expect(picker(page)).toHaveAttribute("data-view", "search");
  const results = page.getByTestId("picker-search-results");
  await expect(results.getByRole("status")).toHaveText("8 个匹配");
  await expect(results.locator("mark").first()).toHaveText("tree-1");
  await expect(page.getByTestId("picker-other-workspaces")).toBeVisible();
  await search.press("ArrowDown");
  await expect(results.locator('[data-project-id="p1"]')).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(results.locator('[data-project-id="p10"]')).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(search).toBeFocused();
  await search.fill("no-such-project");
  await expect(results.getByRole("status")).toHaveText("没有匹配的项目");
  await search.fill("tree-12");
  await search.press("ArrowDown");
  await page.keyboard.press("Enter");
  expect(await actions(page, "SelectKnownProject")).toEqual([
    { type: "SelectKnownProject", value: "p12" },
  ]);
  await expect(picker(page)).toHaveCount(0);
});

test("Escape closes and returns focus to the trigger", async ({ page }) => {
  await mount(page);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(picker(page)).toHaveCount(0);
  await expect(page.locator(".home-workspace-badge-btn")).toBeFocused();
  expect(
    await page.evaluate(() => (window as any).pickerCascade.calls),
  ).toEqual([]);
});

for (const width of [390, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`geometry at ${width} ${theme}: ${width === 390 ? "bottom sheet" : "single column"}`, async ({
      page,
    }, testInfo) => {
      await mount(page, {
        width,
        height: width === 390 ? 844 : 900,
        locale: width === 390 ? "en" : "zh-CN",
        theme,
      });
      const geometry = await page.evaluate(() => {
        const menu = document.querySelector<HTMLElement>(
          '[data-testid="home-project-picker"]',
        )!;
        const box = menu.getBoundingClientRect();
        const row = document
          .querySelector('[data-testid="home-project-item"]')!
          .getBoundingClientRect();
        const input = document.querySelector(".picker-search input")!;
        const trigger = document
          .querySelector(".home-workspace-badge-btn")!
          .getBoundingClientRect();
        return {
          width: Math.round(box.width),
          bottom: Math.round(box.bottom),
          maxHeight: parseFloat(getComputedStyle(menu).maxHeight),
          rowHeight: row.height,
          inputFont: getComputedStyle(input).fontSize,
          triggerHeight: trigger.height,
          overflow: document.documentElement.scrollWidth > innerWidth,
          allVisible: [
            '[data-testid="picker-all-projects"]',
            '[data-host-flavor="chat_only"]',
            '[data-testid="picker-create-project"]',
          ].every((selector) => {
            const r = document.querySelector(selector)!.getBoundingClientRect();
            return r.top >= box.top && r.bottom <= box.bottom + 0.5;
          }),
        };
      });
      expect(geometry.overflow).toBe(false);
      expect(geometry.allVisible).toBe(true);
      if (width === 390) {
        expect(geometry.width).toBe(390);
        expect(geometry.bottom).toBe(844);
        expect(geometry.rowHeight).toBeGreaterThanOrEqual(44);
        expect(geometry.inputFont).toBe("16px");
        expect(geometry.triggerHeight).toBeGreaterThanOrEqual(44);
      } else {
        expect(geometry.width).toBe(400);
        expect(geometry.maxHeight).toBeLessThanOrEqual(560);
      }
      await page.screenshot({
        path: testInfo.outputPath(`picker-${width}-${theme}.png`),
      });
    });
  }
}
