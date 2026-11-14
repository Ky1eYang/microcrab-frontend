import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

for (const status of ["running", "thinking"]) {
  test(`a ${status} child keeps all resident Turns visible on entry`, async ({
    page,
  }) => {
    await nativeBackend(page, {
      children: [
        {
          parent_session_id: "s1",
          id: "busy-child",
          name: "coding",
          status,
          availability: "persisted",
          messages: Array.from({ length: 6 }, (_, turn) => [
            {
              id: `busy-child-user-${turn}`,
              role: "user" as const,
              text: `Child question ${turn}`,
              parts: [],
              tool_calls: [],
              position: { epoch: 1, turn: turn + 1, round: 0 },
            },
            {
              id: `busy-child-answer-${turn}`,
              role: "assistant" as const,
              text: `Child answer ${turn}`,
              parts: [],
              tool_calls: [],
              position: { epoch: 1, turn: turn + 1, round: 1 },
            },
          ]).flat(),
          next_cursor: null,
          messages_truncated: false,
          history_view: {
            lineage: "busy-child-lineage",
            epoch: 1,
            message_count: 12,
            start_cursor: 0,
            end_cursor: 12,
            turns: [],
          },
          receipt: null,
          usage: null,
          executions: [],
          history: null,
        },
      ],
    });
    await page.goto("/#session/s1");
    await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
    await page.getByTestId("header-subagents").click();
    await page
      .locator(".subagent-menu-item")
      .getByRole("button", { name: "详情", exact: true })
      .click();
    const child = page.getByRole("region", { name: "子代理内容", exact: true });
    await expect(
      child.getByText("Child answer 5", { exact: true }),
    ).toBeVisible();
    await expect(child.locator(".user-turn")).toHaveCount(6);
    await expect(
      child.getByText("Child question 0", { exact: true }),
    ).toHaveCount(1);
  });
}
