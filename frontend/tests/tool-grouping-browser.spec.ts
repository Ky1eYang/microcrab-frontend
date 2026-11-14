import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

test("native request-start records keep consecutive tool rounds in one accordion until visible text", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().messages = [
    {
      id: "user",
      role: "user",
      text: "Inspect tools",
      parts: [],
      tool_calls: [],
      position: { epoch: 0, turn: 1, round: 0 },
    },
  ];
  await page.goto("/#session/s1");
  await expect(page.getByTestId("chat-message")).toContainText([
    "Inspect tools",
  ]);
  const observe = (round: number, phase: string, extra = {}) =>
    backend.event("model_observation", {
      operation_id: "turn",
      call_id: `request-${round}`,
      epoch: 0,
      turn: 1,
      round,
      phase,
      ...extra,
    });
  for (const round of [1, 2, 3]) {
    observe(round, "started");
    observe(round, "tool_call_delta", {
      index: 0,
      id: `call-${round}`,
      name: `read_${round}`,
      arguments: JSON.stringify({
        command:
          "Get-Content frontend/src/features/popups/ProjectSettingsDialog.tsx | Select-String -Pattern permission -Context 5,50 ".repeat(
            8,
          ),
      }),
    });
    observe(round, "validated", { text: "" });
  }
  const accordions = page.locator(".tool-accordion-group");
  await expect(accordions).toHaveCount(1);
  await expect(accordions.first()).toContainText("工具调用 3 次");
  const assertFullWidth = async () => {
    await expect
      .poll(async () => {
        return accordions.first().evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const row = element
            .closest(".assistant-turn")!
            .getBoundingClientRect();
          const content = element
            .closest(".transcript-inner")!
            .getBoundingClientRect();
          const composer = document
            .querySelector(".home-composer-box")!
            .getBoundingClientRect();
          return (
            row.width > 200 &&
            Math.abs(rect.width - row.width) <= 2 &&
            Math.abs(rect.width - content.width) <= 2 &&
            (innerWidth < 768
              ? composer.width <= content.width &&
                content.width - composer.width <= 32
              : Math.abs(rect.width - composer.width) <= 2) &&
            rect.left >= content.left - 1 &&
            rect.right <= content.right + 1 &&
            document.documentElement.scrollWidth <= innerWidth
          );
        });
      })
      .toBe(true);
  };
  for (const width of [1920, 1440, 390]) {
    await page.setViewportSize({ width, height: 919 });
    await assertFullWidth();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const groupHeader = accordions
    .first()
    .locator(".tool-accordion-group-header");
  await expect(groupHeader).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("tool-row")).toHaveCount(3);
  await groupHeader.click();
  await expect(groupHeader).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("tool-row")).toHaveCount(0);
  await assertFullWidth();
  await groupHeader.click();
  await assertFullWidth();
  await expect(page.getByTestId("tool-row")).toHaveCount(3);
  await expect(page.getByTestId("tool-row")).toContainText([
    "read_1",
    "read_2",
    "read_3",
  ]);
  await page.getByTestId("tool-row").nth(1).click();
  await expect(page.getByTestId("tool-row").nth(1)).toHaveAttribute(
    "aria-expanded",
    "true",
  );

  observe(4, "started");
  observe(4, "text_delta", { text: "Visible checkpoint" });
  observe(4, "tool_call_delta", {
    index: 0,
    id: "call-4",
    name: "read_4",
    arguments: "{}",
  });
  observe(4, "validated", { text: "Visible checkpoint" });
  await expect(accordions).toHaveCount(2);
  await expect(
    page.getByTestId("chat-message").filter({ hasText: "Visible checkpoint" }),
  ).toBeVisible();
  expect(
    await page
      .locator(".assistant-turn")
      .evaluate((root) =>
        [
          ...root.querySelectorAll(
            ".tool-accordion-group, [data-testid='chat-message']",
          ),
        ]
          .map((node) =>
            node.classList.contains("tool-accordion-group")
              ? "tools"
              : node.textContent,
          )
          .filter((text) => text !== ""),
      ),
  ).toEqual(["tools", "Visible checkpoint", "tools"]);
});
