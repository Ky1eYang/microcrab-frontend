/* Designer Part A regressions (390 composer menu rows, 390 header with SubAgents). */
import { expect, test, type Page } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { connectHostUI } from "./host-fixture";
import { subagentSnapshot } from "./subagent-fixture";

type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.width - 0.5 &&
  b.x < a.x + a.width - 0.5 &&
  a.y < b.y + b.height - 0.5 &&
  b.y < a.y + a.height - 0.5;
const prefs = (page: Page, locale: string) =>
  page.addInitScript(
    (lo) => localStorage.setItem("microcrab.ui.locale", lo),
    locale,
  );

async function rowsDoNotOverlap(page: Page) {
  const rows = page.locator(".composer-action-row");
  const n = await rows.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const parts: Box[] = [];
    for (const sel of [
      ".composer-action-title",
      ".composer-action-hint",
      ".composer-action-desc",
    ]) {
      const el = row.locator(sel);
      if (!(await el.count()) || !(await el.isVisible())) continue;
      parts.push((await el.boundingBox())!);
    }
    for (let a = 0; a < parts.length; a++)
      for (let b = a + 1; b < parts.length; b++)
        expect(overlap(parts[a], parts[b]), `row ${i} parts ${a}/${b}`).toBe(
          false,
        );
    const rowBox = (await row.boundingBox())!;
    for (const p of parts)
      expect(p.x + p.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
  }
}

for (const locale of ["zh-CN", "en"])
  test.describe(`Part A 390 ${locale}`, () => {
    test.use({ viewport: { width: 390, height: 844 } });
    test("+ menu and slash menu rows keep title, hint and description apart", async ({
      page,
    }) => {
      await prefs(page, locale);
      await nativeBackend(page);
      await page.goto("/#session/s1");
      await connectHostUI(page);
      await page
        .getByTestId("composer")
        .locator('[aria-haspopup="listbox"]')
        .first()
        .click();
      await expect(page.getByTestId("composer-action-menu")).toHaveAttribute(
        "data-mode",
        "full",
      );
      await rowsDoNotOverlap(page);
      await page.keyboard.press("Escape");
      await page.getByTestId("composer").locator("textarea").fill("/c");
      await expect(page.locator("#composer-slash-palette")).toHaveAttribute(
        "data-mode",
        "slash",
      );
      await rowsDoNotOverlap(page);
    });

    test("header with SubAgents keeps title and controls inside 390px", async ({
      page,
    }) => {
      await prefs(page, locale);
      const backend = await nativeBackend(page);
      Object.assign(backend.snapshot(), subagentSnapshot("failed"));
      await page.goto("/#session/s1");
      const chip = page.getByTestId("header-subagents");
      await expect(chip).toBeVisible();
      await expect(chip).toHaveAttribute(
        "aria-label",
        locale === "en" ? "Subagents (1)" : "子代理 (1)",
      );
      await expect(chip).not.toContainText("SubAgents");
      const title = (await page
        .locator(".header-left-zone .header-crumb-current")
        .first()
        .boundingBox())!;
      expect(title.width).toBeGreaterThan(16);
      for (const el of await page
        .locator(".header-main-row button, .header-main-row .status-chip")
        .all()) {
        if (!(await el.isVisible())) continue;
        const box = (await el.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(390);
      }
    });
  });

for (const [theme, rgb] of [
  ["light", "rgb(138, 138, 138)"],
  ["dark", "rgb(122, 122, 122)"],
] as const)
  test(`Part A P2: control border, sentence-case labels and zh field colon (${theme})`, async ({
    page,
  }) => {
    await page.goto(
      `/fixture/?scenario=permissions-tools-ready&theme=${theme}&locale=zh-CN`,
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-fixture",
      "ready",
      { timeout: 15000 },
    );
    const select = page.locator(".perm-select").first();
    await expect(select).toBeVisible();
    expect(
      await select.evaluate((el) => getComputedStyle(el).borderTopColor),
    ).toBe(rgb);
    const fact = page.getByTestId("session-permission-policy-fact").first();
    if (await fact.count()) await expect(fact).toContainText("：");
    for (const el of await page
      .locator(
        ".settings-nav-group-label, .payload-label, .model-picker-section-title",
      )
      .all())
      expect(await el.evaluate((n) => getComputedStyle(n).textTransform)).toBe(
        "none",
      );
  });
