import { maintainedPluginBundle } from "./plugin-bundle-fixture";
import { stateInspection } from "./state-inspection-fixture";
import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

test("omitted automatic State and partial execution updates stay distinct from a complete Viewer read", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await maintainedPluginBundle(page);
  backend.snapshot().state = null;
  backend.snapshot().state_omitted = true;
  let release!: () => void;
  const completed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route("**/api/v1/sessions/s1/state/inspection", async (route) => {
    requests++;
    await completed;
    await route.fulfill({
      json: stateInspection(
        {
          custom: { large_variable: "full_explicit_value" },
          executions: [],
        },
        {
          custom: { visibility: "visible", persistence: "persisted" },
        },
      ),
    });
  });

  await page.goto("/#session/s1");
  await page.getByRole("button", { name: "展开 Plugins", exact: true }).click();
  const viewer = page.locator(
    '[data-testid="client-plugin-sidebar"] .plugin-renderer[data-plugin-id="microcrab.state-viewer"]',
  );
  await expect(
    viewer.getByText("正在读取状态…", { exact: true }),
  ).toBeVisible();
  await expect(
    viewer.getByText("full_explicit_value", { exact: false }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Test User", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "客户端工具", exact: true }).click();
  backend.event("executions.updated", {
    items: [
      {
        capabilities: { input: false },
        execution_id: 2,
        session_id: "s1",
        call_id: "c",
        tool: "slow",
        agent: "coding",
        mode: "build",
        status: "running",
      },
    ],
  });
  await expect(page.getByText("正在执行 · #2", { exact: true })).toBeVisible();
  await expect(
    page.getByText("公开 SessionState（只读）", { exact: true }),
  ).toHaveCount(0);
  expect(requests).toBe(1);
  release();
  await page.keyboard.press("Escape");
  await expect(
    viewer.getByText("full_explicit_value", { exact: false }),
  ).toBeVisible();
  await expect(viewer.getByText("正在读取状态…", { exact: true })).toHaveCount(
    0,
  );
});
