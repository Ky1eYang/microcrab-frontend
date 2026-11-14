/* Part B acceptance regressions D1–D6 (PART_B.md). */
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { nativeBackend } from "./native-fixture";

const loc = (f: string) =>
  JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "src/i18n/locales", f), "utf8"),
  ) as Record<string, string>;
const zh = loc("zh-CN.json"),
  en = loc("en.json");
const SHOTS = process.env.POLISH_SHOTS_DIR;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
const ready = async (
  page: Page,
  scenario: string,
  theme: string,
  locale: string,
) => {
  await page.goto(
    `/fixture/?scenario=${scenario}&theme=${theme}&locale=${locale}`,
  );
  await expect(page.locator("html")).toHaveAttribute("data-fixture", "ready", {
    timeout: 15000,
  });
};

// Both layouts, themes and locales remain represented without multiplying the
// same focus-trap and disclosure lifecycle across every visual combination.
for (const { width, theme, locale } of [
  { width: 1440, theme: "light", locale: "zh-CN" },
  { width: 390, theme: "dark", locale: "en" },
])
  test(`D1/D2/D5 Search ${width} ${theme} ${locale}`, async ({ page }) => {
    await page.setViewportSize({
      width,
      height: width === 390 ? 844 : 900,
    });
    await ready(page, "default", theme, locale);
    const trigger = (
      width === 390
        ? page.getByRole("button", {
            name: /搜索会话|Search conversations/,
          })
        : page.locator(".subnav-item-btn", {
            hasText: /会话历史|Session history/,
          })
    )
      .locator("visible=true")
      .first();
    const dialog = page.locator(".search-dialog[role=dialog]");
    // The rail renders before bootstrap settles under load; retry the keyboard open.
    await expect(async () => {
      if (!(await dialog.isVisible())) {
        await trigger.focus();
        await page.keyboard.press("Enter");
      }
      await expect(dialog).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15000 });
    await expect(page.locator(".search-dialog-input")).toBeFocused();
    // D1: Tab and Shift+Tab never leave the dialog, including after Details expands.
    const inside = () =>
      page.evaluate(() => !!document.activeElement?.closest(".search-dialog"));
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      expect(await inside(), `Tab #${i + 1}`).toBe(true);
    }
    await page.locator(".preview-info-toggle-btn").click();
    await expect(page.locator(".search-preview-meta-grid")).toBeVisible();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(await inside(), `Shift+Tab #${i + 1}`).toBe(true);
    }
    // D2: Open session is fully inside the dialog and viewport; preview is readable.
    const open = page.getByTestId("search-open-session");
    const [d, o, pv] = await Promise.all([
      dialog.boundingBox(),
      open.boundingBox(),
      page.locator(".search-dialog-preview").boundingBox(),
    ]);
    expect(o!.x).toBeGreaterThanOrEqual(d!.x);
    expect(o!.x + o!.width).toBeLessThanOrEqual(d!.x + d!.width + 0.5);
    expect(o!.x + o!.width).toBeLessThanOrEqual(width);
    expect(pv!.width).toBeGreaterThan(width === 390 ? 300 : 600);
    // D5: sentence-case headings.
    for (const sel of [".search-preview-badge", ".preview-section-header"])
      expect(
        await page
          .locator(sel)
          .first()
          .evaluate((n) => getComputedStyle(n).textTransform),
      ).toBe("none");
    await page.locator(".preview-info-toggle-btn").click();
    await shot(page, `search-${width}-${theme}-${locale}`);
    // Escape closes and restores focus to the opener.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

for (const { theme, locale } of [
  { theme: "light", locale: "zh-CN" },
  { theme: "dark", locale: "en" },
])
  test(`D3 queue item expands and collapses with keyboard and pointer (390 ${theme} ${locale})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await ready(page, "inbox-mixed-draft", theme, locale);
    const row = page.getByTestId("queue-item").first();
    const toggle = row.getByTestId("queue-item-toggle");
    const full = row.getByTestId("queue-item-full");
    const raw = await full.evaluate((n) => n.textContent);
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(row.locator("details")).toHaveAttribute("open", "");
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeFocused();
    await expect(toggle).toContainText(
      locale === "en" ? "Collapse full text" : "收起全文",
    );
    expect(await full.evaluate((n) => n.textContent)).toBe(raw);
    await shot(page, `queue-expanded-390-${theme}-${locale}`);
    await page.keyboard.press("Space");
    await expect(row.locator("details")).not.toHaveAttribute("open", "");
    await expect(toggle).toBeFocused();
    await toggle.click();
    await expect(row.locator("details")).toHaveAttribute("open", "");
    await toggle.click();
    await expect(row.locator("details")).not.toHaveAttribute("open", "");
  });

test("D4 reset scope note is adjacent to the normal Reset, with zh/en parity", async ({
  page,
}) => {
  for (const key of [
    "sessionPermissions.resetScope",
    "sessionPermissions.saveUnsupported",
    "composer.inbox.collapseFull",
  ]) {
    expect((zh as Record<string, string>)[key]).toBeTruthy();
    expect((en as Record<string, string>)[key]).toBeTruthy();
  }
  expect(en["sessionPermissions.resetScope"]).toMatch(
    /whole tool list.*other modes/,
  );
  await ready(page, "permissions-tools-ready", "light", "en");
  const reset = page.getByTestId("session-permission-reset");
  await expect(reset).toBeEnabled();
  const note = page.getByTestId("session-permission-reset-scope");
  await expect(note).toBeVisible();
  await expect(reset).toHaveAttribute(
    "aria-describedby",
    (await note.getAttribute("id"))!,
  );
});

test("D6 without permission.set: Save disabled with a visible, described reason and no write", async ({
  page,
}) => {
  await nativeBackend(page, { withoutMethods: ["permission.set"] });
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/permission") && r.method() !== "GET")
      writes.push(`${r.method()} ${r.url()}`);
  });
  await page.goto("/#session/s1");
  await page.getByTestId("composer-session-permissions").click();
  const save = page.getByTestId("session-permission-save");
  await expect(save).toBeDisabled();
  const reason = page.getByTestId("session-permission-save-unsupported");
  await expect(reason).toBeVisible();
  await expect(save).toHaveAttribute(
    "aria-describedby",
    (await reason.getAttribute("id"))!,
  );
  await expect(save).toHaveAttribute("title", /permission\.set/);
  await shot(page, "permissions-save-unsupported-1440-light-zh-CN");
  expect(writes).toEqual([]);
});
