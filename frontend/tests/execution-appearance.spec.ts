import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

test("current execution UI follows the shared skin in both themes and viewport sizes", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().executions = [
    {
      execution_id: 23,
      session_id: "s1",
      call_id: "call-23",
      tool: "external_records_with_a_long_unbroken_name_".repeat(4),
      agent: "universal",
      mode: null,
      status: "failed",
      capabilities: { input: false },
      failure: {
        kind: "failed",
        code: "unavailable",
        message: "Output unavailable",
        retryable: false,
      },
      diagnostic: {
        code: "unavailable",
        layer: "host",
        phase: "execution",
        effects: "unknown",
        operation: "external_operation_".repeat(12),
      },
      result: JSON.stringify({
        note: "Opaque final result",
        records: Array.from({ length: 50 }, (_, i) => `record ${i}`),
      }),
    },
  ];
  await page.goto("/#session/s1");
  await page.getByRole("button", { name: "Test User", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "客户端工具", exact: true }).click();
  const execution = page.getByTestId("execution-23");
  await execution.getByText("最终结果", { exact: true }).click();
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(execution).toBeVisible();
      await expect(execution).toHaveAttribute("data-status", "failed");
      await expect(
        execution.getByRole("region", { name: "工具错误诊断" }),
      ).toContainText("副作用未知，重试前应核对");
      await expect(execution.locator(".payload")).toBeVisible();
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(0);
      expect(
        await execution.evaluate((node) => node.scrollWidth - node.clientWidth),
      ).toBeLessThanOrEqual(1);
      await page.screenshot({
        path: `../target/beautify-v019-executions-${theme}-${width}.png`,
        fullPage: true,
      });
    }
  }
});
