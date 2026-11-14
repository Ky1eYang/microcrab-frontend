import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

test("parameters results and Schema scroll and expand through the shared dialog", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const backend = await nativeBackend(page);
  const lines = Array.from({ length: 24 }, (_, i) => `Value ${i}`);
  backend.snapshot().messages = [
    {
      id: "u",
      role: "user",
      text: "Inspect",
      parts: [],
      tool_calls: [],
      position: { epoch: 2, turn: 1, round: 0 },
    },
    {
      id: "a",
      role: "assistant",
      text: null,
      parts: [],
      tool_calls: [{ id: "c", name: "pwsh", arguments: { lines } }],
      position: { epoch: 2, turn: 1, round: 1 },
    },
    {
      id: "t",
      role: "tool",
      text: lines.join("\n"),
      parts: [],
      tool_calls: [],
      call_id: "c",
      tool_name: "pwsh",
      position: { epoch: 2, turn: 1, round: 1 },
    },
  ];
  await page.route("**/api/v1/sessions/s1/audit/requests", (route) =>
    route.fulfill({
      json: {
        status: "available",
        attempts: [
          {
            request_hash: "main",
            epoch: 2,
            turn: 1,
            round: 1,
            status: "available",
            tools: [
              {
                type: "function",
                function: {
                  name: "pwsh",
                  parameters: { type: "string", enum: lines },
                },
              },
            ],
          },
        ],
      },
    }),
  );
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  await page
    .locator('[data-testid="trajectory-entry"][data-kind="tool"]')
    .first()
    .click();
  const inspector = page.getByTestId("trajectory-inspector");
  for (const name of ["参数", "结果", "Schema"]) {
    await page.setViewportSize({ width: 1440, height: 1100 });
    const entries = page.locator(
      '[data-testid="trajectory-entry"][data-kind="tool"]',
    );
    await (name === "结果" ? entries.last() : entries.first()).click();
    await page.getByRole("tab", { name, exact: true }).click();
    const body = inspector.locator('[data-fill-body="true"]');
    await expect(body).toBeVisible();
    await expect
      .poll(() => body.locator("pre").evaluate((el) => el.scrollHeight))
      .toBeGreaterThan(320);
    await expect(
      inspector.getByRole("button", { name: "展开全部", exact: true }),
    ).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 500 });
    await expect(
      inspector.getByRole("button", { name: "展开全部", exact: true }),
    ).toHaveCount(0);
    // E1: single scroll owner is the pane scroller; payload body stays visible.
    expect(
      await body.locator("pre").evaluate((el) => ({
        overflow: getComputedStyle(el).overflowY,
        mask: getComputedStyle(el).maskImage,
      })),
    ).toEqual({ overflow: "visible", mask: "none" });
    const scroller = inspector.locator(
      name === "Schema" ? ".request-audit-diff" : ".trajectory-scroll-area",
    );
    await expect(scroller).toBeVisible();
    const metrics = await scroller.evaluate((el) => ({
      overflow: getComputedStyle(el).overflowY,
      scrollable: el.scrollHeight > el.clientHeight + 1,
    }));
    expect(metrics.overflow).toMatch(/auto|scroll/);
    // Schema may fit without needing scroll at this viewport; 参数/结果 should scroll.
    if (name !== "Schema") expect(metrics.scrollable).toBe(true);
    await body.getByTestId("payload-dialog-expand").click();
    const dialog = page.getByTestId("content-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Value 23");
    await expect(dialog.getByTestId("payload-dialog-expand")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(inspector).toBeVisible();
  }
});
