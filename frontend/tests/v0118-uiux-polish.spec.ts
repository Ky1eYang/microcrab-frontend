import { expect, test, type Page } from "@playwright/test";

/* v0.1.18 UI/UX polish acceptance, driven through the Designer review
 * fixture (fixture/scenarios.ts) on the test dev server. */
async function scenario(page: Page, id: string, extra = "") {
  await page.goto(`/fixture/?scenario=${id}&theme=light&locale=zh-CN${extra}`);
  await expect(page.locator("html")).toHaveAttribute("data-fixture", "ready", {
    timeout: 20000,
  });
}

test.describe("touch (hover: none) at 390", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("3.1 failed reply shows a labelled 44px Retry without hover", async ({
    page,
  }) => {
    await scenario(page, "retry-failure");
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(
      true,
    );
    const retry = page
      .getByTestId("operation-failure")
      .getByTestId("retry-model-request");
    await expect(retry).toBeVisible();
    await expect(retry).toHaveText("重试");
    await expect(retry).toHaveAccessibleName("重试");
    expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });
});

test.describe("narrow 390", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("3.3 host-offline notice is one 44px line that expands and collapses", async ({
    page,
  }) => {
    await scenario(page, "default");
    const notice = page.locator(".composer-offline-banner").first();
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute("data-expanded", "false");
    // The composer reveals the banner with a short height transition.
    await expect
      .poll(() => notice.evaluate((el) => el.getBoundingClientRect().height))
      .toBeGreaterThanOrEqual(44);
    const toggle = notice.locator(".expandable-notice-toggle");
    await expect(toggle).toHaveText(/说明/);
    await toggle.click();
    await expect(notice).toHaveAttribute("data-expanded", "true");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await toggle.click();
    await expect(notice).toHaveAttribute("data-expanded", "false");
  });

  test("3.2 actionable permission cards: Will run, Deny then Allow once, no overflow", async ({
    page,
  }) => {
    await scenario(page, "permission-request-actionable");
    const cards = page.locator(".permission-card");
    await expect(cards.first()).toBeVisible();
    const first = cards.first();
    await expect(first.locator(".permission-will-run-body")).toBeVisible();
    const labels = await first
      .locator(".flow-card-actions button")
      .allInnerTexts();
    expect(labels.map((label) => label.trim()).slice(-2)).toEqual([
      "拒绝",
      "允许本次",
    ]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });

  test("3.2 observer permission card has no action buttons", async ({
    page,
  }) => {
    await scenario(page, "permission-request");
    const card = page.locator(".permission-card").first();
    await expect(card).toBeVisible();
    await expect(card.getByRole("button", { name: "允许本次" })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "拒绝" })).toHaveCount(0);
  });

  test("3.5 queue starts collapsed and inputs are 16px", async ({ page }) => {
    await scenario(page, "inbox-mixed-draft");
    await expect(page.locator(".queue-dock-header")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(page.getByTestId("composer").locator("textarea")).toHaveCSS(
      "font-size",
      "16px",
    );
  });

  test("P2-2 permission JSON wraps inside the card", async ({ page }) => {
    await scenario(page, "permission-request");
    const details = page.locator(".permission-card .flow-card-details").first();
    await details.evaluate((el) => ((el as HTMLDetailsElement).open = true));
    const body = details.locator(".payload-body").first();
    await expect(body).toBeVisible();
    expect(
      await body.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    const card = (await page
      .locator(".permission-card")
      .first()
      .boundingBox())!;
    const box = (await body.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width + 0.5);
  });

  test("P2-1 rail never shows epoch ages", async ({ page }) => {
    await scenario(page, "default");
    await page.getByTestId("header-open-rail").click();
    const times = await page.locator(".session-item-time").allInnerTexts();
    expect(times.length).toBeGreaterThan(0);
    for (const time of times)
      expect(time).toMatch(/^(now|\d{1,3}[mhd]|\d+y|—)$/);
  });

  test("P1-1 settings feedback banner and toast stay compact and reveal full text", async ({
    page,
  }) => {
    await scenario(page, "settings-feedback");
    const banner = page.locator(".settings-feedback-banner.expandable-notice");
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute("data-expanded", "false");
    await expect(banner).toHaveAttribute("data-expandable", "true");
    await banner.locator(".expandable-notice-toggle").click();
    await expect(banner).toHaveAttribute("data-expanded", "true");
    const toast = page.getByTestId("toast-body");
    await expect(toast).toHaveAttribute("data-expanded", "false");
    await expect(toast).toHaveCSS("-webkit-line-clamp", "2");
    const clamped = (await toast.boundingBox())!.height;
    await toast.click();
    await expect(toast).toHaveAttribute("data-expanded", "true");
    expect((await toast.boundingBox())!.height).toBeGreaterThan(clamped);
  });

  test("3.6 no collapsed icon rail; header menu opens the drawer", async ({
    page,
  }) => {
    await scenario(page, "default");
    await expect(page.locator(".session-rail.collapsed-rail")).toHaveCount(0);
    const menu = page.getByTestId("header-open-rail");
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("nav-new-chat").first()).toBeVisible();
  });
});

test.describe("narrow 320", () => {
  test.use({ viewport: { width: 320, height: 720 } });

  test("P1-1 queue draft note ellipsizes to one line and expands", async ({
    page,
  }) => {
    await scenario(page, "inbox-mixed-draft");
    const note = page.getByTestId("inbox-draft-note");
    await expect(note).toHaveAttribute("data-expanded", "false");
    await expect(note).toHaveAttribute("data-expandable", "true");
    const text = note.locator(".offline-text");
    await expect(text).toHaveCSS("white-space", "nowrap");
    await expect(text).toHaveCSS("text-overflow", "ellipsis");
    await note.locator(".expandable-notice-toggle").click();
    await expect(note).toHaveAttribute("data-expanded", "true");
    await expect(text).not.toHaveCSS("white-space", "nowrap");
  });
});

test.describe("desktop 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("3.1 Retry is visible without hover on desktop and at least 32px", async ({
    page,
  }) => {
    await scenario(page, "retry-failure");
    const retry = page
      .getByTestId("operation-failure")
      .getByTestId("retry-model-request");
    await expect(retry).toBeVisible();
    expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(32);
  });

  test("3.4 tool group header carries outcome glyphs with accessible labels", async ({
    page,
  }) => {
    await scenario(page, "tools-mixed-status");
    const glyphs = page.getByTestId("tool-group-outcomes").first();
    await expect(glyphs).toBeVisible();
    await expect(glyphs.locator(".sr-only").first()).not.toBeEmpty();
  });

  test("3.7 login error is an alert", async ({ page }) => {
    await scenario(page, "login-error");
    await expect(page.getByTestId("auth-login-error")).toHaveAttribute(
      "role",
      "alert",
    );
  });
});
