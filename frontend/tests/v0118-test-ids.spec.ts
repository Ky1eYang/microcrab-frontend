import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

/* Stable automation hooks (v0.1.18 §3.11): primary navigation, session view
 * tabs, message copy, labelled send and the attached session status. */
for (const width of [1440, 390]) {
  test(`navigation, tabs and session hooks at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await nativeBackend(page);
    await page.goto("/#session/s1");
    await expect(page.locator(".shell")).toHaveAttribute(
      "data-session-status",
      "idle",
    );
    await expect(page.getByTestId("tab-conversation")).toBeVisible();
    await expect(page.getByTestId("tab-trace")).toBeVisible();
    await expect(page.getByTestId("copy-message").first()).toBeAttached();
    await expect(page.getByTestId("composer-send")).toHaveAttribute(
      "aria-label",
      "发送 (Enter)",
    );
    if (width < 768) await page.getByTestId("header-open-rail").click();
    for (const id of ["nav-new-chat", "nav-dashboard", "nav-history"])
      await expect(page.getByTestId(id).first()).toBeVisible();
  });
}
