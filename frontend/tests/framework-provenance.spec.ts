import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

test("framework history remains source-labeled and ordinary user text retains its origin after reload", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().messages = [
    {
      id: "user",
      role: "user",
      text: "Framework notice is ordinary user text here",
      parts: [],
      tool_calls: [],
    },
    {
      id: "wake",
      role: "user",
      source: "framework",
      text: "Background execution settled: execution-1",
      parts: [],
      tool_calls: [],
    },
    {
      id: "reply",
      role: "assistant",
      text: "Observed background completion",
      parts: [],
      tool_calls: [],
    },
  ];
  await page.goto("/#session/s1");
  const assertOrigins = async () => {
    await expect(page.getByTestId("input-source-label")).toHaveText("框架通知");
    await expect(page.locator('[data-message-source="carrier"]')).toHaveCount(
      1,
    );
    await expect(page.locator(".transcript-inner")).toContainText(
      "execution-1",
    );
    await expect(page.getByTestId("undo-user-block")).toHaveCount(1);
    await expect(page.getByTestId("undo-user-block")).toHaveAttribute(
      "data-message-id",
      "user",
    );
    await expect(page.locator(".transcript-inner")).toContainText(
      "Observed background completion",
    );
    await expect(page.locator('[data-message-source="user"]')).toContainText(
      "ordinary user text",
    );
  };
  await assertOrigins();
  await page.reload();
  await assertOrigins();
});
