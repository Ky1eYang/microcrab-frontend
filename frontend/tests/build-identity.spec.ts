import { expect, test } from "@playwright/test";
import pkg from "../package.json" with { type: "json" };
import { nativeBackend } from "./native-fixture";

const { version } = pkg;
const backendHash = "a".repeat(64);
const frontendHash = "b".repeat(64);

for (const hasBuild of [true, false]) {
  test(`About uses ${hasBuild ? "reported" : "missing"} backend metadata without showing the frontend version`, async ({ page }) => {
    await page.addInitScript((hash) => {
      localStorage.setItem("microcrab.ui.locale", "en");
      // The dev server has no production bundle. Simulate its HTML metadata.
      document.addEventListener("DOMContentLoaded", () => {
        const meta = document.createElement("meta");
        meta.name = "microcrab-frontend-sha256";
        meta.content = hash;
        document.head.append(meta);
      });
    }, frontendHash);
    await nativeBackend(page, hasBuild ? {
      serverBuild: { version: "9.8.7", sha256: backendHash },
    } : {});
    await page.goto("/#session/s1");
    const sidebarVersion = page.locator(".user-card-version");
    await expect(sidebarVersion).toHaveText(`v${version}`);
    await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
    await expect(sidebarVersion).toHaveCount(0);
    await page.locator(".user-card-btn").first().click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await dialog.getByRole("button", { name: "About microcrab", exact: true }).click();
    const missing = "Not reported by the server";
    await expect(dialog.getByText(`Backend version: ${hasBuild ? "9.8.7" : missing}`, { exact: true })).toBeVisible();
    await expect(dialog.getByText(`Backend SHA-256: ${hasBuild ? backendHash : missing}`, { exact: true })).toBeVisible();
    await expect(dialog).not.toContainText(version);
    await expect(dialog.getByText("Frontend build SHA-256")).toBeVisible();
    await expect(dialog.getByText(frontendHash, { exact: true })).toBeVisible();
  });
}
