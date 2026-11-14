import { stateInspection } from "./state-inspection-fixture";
import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

test("emitted State Viewer Worker renders full-page UI across themes and mobile widths", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.route("**/api/v1/sessions/s1/state/inspection", (route) =>
    route.fulfill({
      json: stateInspection(
        {
          configuration: {
            workspace: "controlled-browser-fixture",
            enabled: true,
          },
          private_setting: { original: "owner-visible fixture value" },
          live_setting: [1, 2, 3],
        },
        {
          configuration: { visibility: "visible", persistence: "persisted" },
          private_setting: {
            visibility: "invisible",
            persistence: "persisted",
          },
          live_setting: { visibility: "invisible", persistence: "ephemeral" },
        },
      ),
    }),
  );

  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/#/session/s1/plugins/microcrab.state-viewer");
  const expanded = page.getByTestId("expanded-plugin-page");
  await expect(
    expanded.getByText("controlled-browser-fixture", { exact: false }),
  ).toBeVisible({ timeout: 20000 });
  await expect(
    expanded.getByText("owner-visible fixture value", { exact: false }),
  ).toHaveCount(0);
  await expanded
    .getByRole("button", { name: /^显示模型不可见的值/, pressed: false })
    .click();
  await expect(
    expanded.getByText("owner-visible fixture value", { exact: false }),
  ).toBeVisible();
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(expanded).toBeVisible();
      if (width === 390) {
        await expect
          .poll(async () => (await expanded.boundingBox())?.width ?? 0)
          .toBeGreaterThan(300);
      }
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document.documentElement.scrollWidth <=
              document.documentElement.clientWidth,
          ),
        )
        .toBe(true);
      if (theme === "light")
        await page.screenshot({
          path: `test-results/visual/client-plugin-governed-state-viewer-${width}.png`,
          fullPage: true,
        });
    }
  }
});
