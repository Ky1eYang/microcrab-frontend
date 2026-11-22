import { expect, test, type Page } from "@playwright/test";

/* v0.1.18 design language applied to the v0.1.20 request_secret card:
 * Decline | Provide (solid), observers see only a status line, and the
 * reveal toggle keeps a 44px target on narrow/touch layouts. No values are
 * typed, so no Secret material can land in traces. */
async function scenario(page: Page, id: string) {
  await page.goto(`/fixture/?scenario=${id}&theme=light&locale=zh-CN`);
  await expect(page.locator("html")).toHaveAttribute("data-fixture", "ready", {
    timeout: 30000,
  });
}

test("participant card keeps Decline then Provide in the shared action row", async ({
  page,
}) => {
  await scenario(page, "secret-request");
  const card = page.getByTestId("secret-request");
  await expect(card).toHaveAttribute("data-status", "ready");
  const labels = await card
    .locator(".flow-card-actions button")
    .allInnerTexts();
  expect(labels.map((label) => label.trim())).toEqual([
    "拒绝提供",
    "提供私密值",
  ]);
  await expect(card.locator(".flow-card-actions .primary-btn")).toHaveText(
    "提供私密值",
  );
});

test("observer card shows only its status line", async ({ page }) => {
  await scenario(page, "secret-request-observer");
  const card = page.getByTestId("secret-request");
  await expect(card).toHaveAttribute("data-status", "observer");
  await expect(card.getByTestId("secret-observer")).toBeVisible();
  await expect(card.locator("form")).toHaveCount(0);
  await expect(card.locator("button:disabled")).toHaveCount(0);
});

test.describe("narrow 390", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test("reveal toggles are at least 44px and nothing overflows", async ({
    page,
  }) => {
    await scenario(page, "secret-request");
    const toggles = page.locator(".secret-visibility");
    await expect(toggles).toHaveCount(2);
    for (const box of await toggles.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().toJSON()),
    )) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
});
