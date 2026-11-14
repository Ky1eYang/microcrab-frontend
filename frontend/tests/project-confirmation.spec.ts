import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

test("project rename ignores repeated Enter while a confirmation is pending", async ({
  page,
}) => {
  await nativeBackend(page);
  let requests = 0;
  let release = () => {};
  await page.route("**/api/v1/projects/project-1", (route) => {
    requests++;
    release = () => {
      void route.fulfill({
        json: { id: "project-1", name: "Renamed once", root: "/assigned" },
      });
    };
  });
  await page.goto("/");
  await page.locator(".rail-project-row").hover();
  await page.locator(".rail-project-more-btn").click();
  await page.getByRole("button", { name: "重命名项目", exact: true }).click();
  const input = page.getByLabel("项目名称", { exact: true });
  await input.fill("Renamed once");
  await input.press("Enter");
  await expect.poll(() => requests).toBe(1);
  await expect(
    page.getByRole("button", { name: "保存", exact: true }),
  ).toBeDisabled();
  await input.press("Enter");
  await input.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "重命名项目", exact: true }),
  ).toBeVisible();
  expect(requests).toBe(1);
  release();
  await expect(
    page.getByRole("dialog", { name: "重命名项目", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".rail-project-title")).toHaveText("Renamed once");
});
