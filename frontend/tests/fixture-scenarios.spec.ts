/* Keep Designer fixture staging smoke in one locale. Product localization is
 * asserted by locale-chrome, interaction-polish and project-settings-i18n. */
import { expect, test } from "@playwright/test";
import { SCENARIOS } from "../fixture/scenarios";

const locale = "zh-CN";
for (const id of [...Object.keys(SCENARIOS), "attachments"])
  test(`fixture scenario ${id} (${locale}) stages without errors`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/fixture/?scenario=${id}&theme=dark&locale=${locale}`);
    if (id === "attachments")
      await expect(page.getByTestId("composer-images")).toBeVisible();
    else
      await expect(page.locator("html")).toHaveAttribute(
        "data-fixture",
        "ready",
        { timeout: 15000 },
      );
    const openChildStatus: Record<string, string> = {
      "subagent-idle": "idle",
      "subagent-pending": "loading",
      "subagent-weird-unknown": "unknown",
    };
    if (id in openChildStatus) {
      const status = page.getByTestId("subagent-status");
      await expect(status).toHaveAttribute("data-status", openChildStatus[id]);
      await expect(status).toHaveAttribute(
        "data-raw-status",
        id.slice("subagent-".length),
      );
      await expect(page.locator(".subagent-card")).toHaveAttribute(
        "data-readonly",
        "true",
      );
    }
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(errors).toEqual([]);
  });

test("fixture index lists scenarios with stable links", async ({ page }) => {
  await page.goto("/fixture/");
  await expect(
    page.locator(
      'a[href="?scenario=permissions-tools-ready&theme=light&locale=en"]',
    ),
  ).toBeVisible();
});

test("fixture tools-mixed-status opens every status row by default", async ({
  page,
}) => {
  await page.goto(
    "/fixture/?scenario=tools-mixed-status&theme=light&locale=en",
  );
  await expect(page.locator("html")).toHaveAttribute("data-fixture", "ready", {
    timeout: 15000,
  });
  for (const status of [
    "succeeded",
    "unknown",
    "running",
    "failed",
    "cancelled",
  ])
    await expect(
      page.locator(`[data-testid="tool-row"][data-status="${status}"]`).first(),
    ).toBeVisible();
});

for (const reducedMotion of ["no-preference", "reduce"] as const)
  test(`fixture tools-running-motion computed animation (${reducedMotion})`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto(
      "/fixture/?scenario=tools-running-motion&theme=light&locale=en",
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-fixture",
      "ready",
      { timeout: 15000 },
    );
    const glyph = page
      .locator('[data-testid="tool-row"][data-status="running"] svg')
      .first();
    await expect(glyph).toBeVisible();
    const state = await glyph.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        name: cs.animationName,
        duration: cs.animationDuration,
        running: el.getAnimations().length,
      };
    });
    const probe = page.getByTestId("fixture-motion-probe");
    if (reducedMotion === "reduce") {
      expect(
        state.name === "none" ||
          state.running === 0 ||
          state.duration.startsWith("0"),
      ).toBe(true);
      await expect(probe).toHaveAttribute("data-reduce", "true");
    } else {
      expect(state.name).not.toBe("none");
      expect(state.running).toBeGreaterThan(0);
      await expect(probe).toHaveAttribute("data-reduce", "false");
    }
  });
