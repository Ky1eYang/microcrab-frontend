import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { connectHostUI } from "./host-fixture";
import type { NativeChildDetail } from "../src/client/types";

for (const { theme, width } of [
  { theme: "light", width: 1440 },
  { theme: "dark", width: 390 },
] as const) {
  test(`child input and overview retain shared interactions at ${width} in ${theme}`, async ({
    page,
  }) => {
    await page.addInitScript(
      (value) => localStorage.setItem("microcrab.ui.theme", value),
      theme,
    );
    const detail: NativeChildDetail = {
      parent_session_id: "s1",
      id: "child-overview",
      name: "coding",
      status: "succeeded",
      availability: "persisted",
      messages: [
        {
          id: "child-request",
          role: "user",
          text: "Inspect the child conversation",
          parts: [],
          tool_calls: [],
        },
        {
          id: "child-answer",
          role: "assistant",
          text: "Child answer with **shared Markdown**.",
          parts: [],
          tool_calls: [],
        },
      ],
      next_cursor: null,
      messages_truncated: false,
      receipt: {
        source: "child",
        result: "<strong>metadata remains literal</strong>",
      },
      usage: {
        input_tokens: 1000,
        cache_read_tokens: 750,
        cache_write_tokens: 50,
        uncached_input_tokens: 200,
        output_tokens: 123,
        total_tokens: 1123,
      },
      executions: [],
      history: { epoch: 3, turn: 1 },
    };
    const backend = await nativeBackend(page, { children: [detail] });
    backend.snapshot().usage = { input_tokens: 99123, total_tokens: 99123 };
    await page.goto("/#session/s1");
    await connectHostUI(page);
    await page
      .getByRole("textbox", { name: "消息", exact: true })
      .fill("Preserve parent draft");
    await page.getByTestId("header-subagents").click();
    await page
      .locator(".subagent-menu-item")
      .getByRole("button", { name: "详情", exact: true })
      .click();
    const child = page.getByTestId("child-content-view");
    await expect(
      child.getByRole("textbox", { name: "消息", exact: true }),
    ).toBeDisabled();
    await expect(
      child.getByRole("textbox", { name: "消息", exact: true }),
    ).toHaveValue("");
    await expect(child.getByTestId("parent-input-label")).toHaveCount(0);
    await expect(child).not.toContainText("父代理输入");
    await expect(child.locator(".user-turn .user-bubble")).toContainText(
      "Inspect the child conversation",
    );
    await expect(child.locator(".assistant-turn strong")).toHaveText(
      "shared Markdown",
    );
    await expect(child.getByTitle("复制回答", { exact: true })).toBeEnabled();
    await page.setViewportSize({ width, height: 1000 });
    const dock = child.getByTestId("statistics-dock");
    await expect(
      dock.locator(".dock-pills-group > .dock-pill-wrapper"),
    ).toHaveCount(2);
    await expect(
      dock.locator(".dock-pills-group").getByTestId("child-metadata"),
    ).toHaveCount(0);
    await expect(dock.getByTestId("child-metadata")).toBeVisible();
    await expect(child.getByTestId("statistics-activity")).toContainText(
      "当前轮次 —",
    );
    await expect(child.getByTestId("statistics-usage")).toContainText(
      "上下文 —",
    );
    await child.getByTestId("statistics-activity").click();
    const activity = child.getByRole("dialog", {
      name: "活动概览",
      exact: true,
    });
    await expect(activity).toContainText("1,000");
    await expect(activity).not.toContainText("99,123");
    await page.keyboard.press("Escape");
    await expect(child.getByTestId("statistics-activity")).toBeFocused();
    await child.getByTestId("statistics-usage").click();
    const usage = child.getByRole("dialog", {
      name: "消耗与上下文",
      exact: true,
    });
    await expect(usage).toContainText("75.0%");
    await expect(usage).toContainText("1,123");
    await expect(usage).not.toContainText("99,123");
    const bounds = await usage.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
    await expect(usage).toHaveCount(0);
    await expect(child).toBeVisible();
    await expect(child.getByTestId("statistics-usage")).toBeFocused();
    await child.getByTestId("child-metadata").click();
    const metadata = page.getByRole("dialog", {
      name: "会话信息",
      exact: true,
    });
    await expect(metadata).toHaveAttribute("aria-modal", "true");
    await expect(
      metadata.getByRole("button", { name: "关闭", exact: true }),
    ).toBeFocused();
    const metadataBounds = await metadata.boundingBox();
    expect(metadataBounds).not.toBeNull();
    expect(metadataBounds!.x).toBeGreaterThanOrEqual(0);
    expect(metadataBounds!.y).toBeGreaterThanOrEqual(0);
    expect(metadataBounds!.x + metadataBounds!.width).toBeLessThanOrEqual(
      width,
    );
    expect(metadataBounds!.y + metadataBounds!.height).toBeLessThanOrEqual(
      1000,
    );
    await metadata.getByText("回执", { exact: true }).click();
    await expect(metadata.getByTestId("child-receipt-payload")).toContainText(
      "metadata remains literal",
    );
    await expect(metadata.locator("strong")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(metadata).toHaveCount(0);
    await expect(child).toBeVisible();
    await expect(child.getByTestId("child-metadata")).toBeFocused();
    await child.getByTestId("child-metadata").click();
    await page
      .getByRole("dialog", { name: "会话信息", exact: true })
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    await expect(metadata).toHaveCount(0);
    await expect(child.getByTestId("child-metadata")).toBeFocused();
    await child.getByRole("button", { name: "刷新记录", exact: true }).click();
    await expect(
      child.getByRole("button", { name: "刷新记录", exact: true }),
    ).toBeEnabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page
      .getByRole("navigation", { name: "会话路径" })
      .getByRole("button", { name: "原生会话", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "消息", exact: true }),
    ).toHaveValue("Preserve parent draft");
    expect(
      backend.requests.some((request) =>
        request.path.startsWith("/api/v1/sessions/child-overview"),
      ),
    ).toBe(false);
    expect(
      backend.commands.some((command) => command.method === "turn.queue"),
    ).toBe(false);
  });
}
