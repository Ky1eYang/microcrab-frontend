import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import type { NativeChildDetail } from "../src/client/types";

test("child chat and trajectory share production session views under parent read authority", async ({
  page,
}) => {
  const detail: NativeChildDetail = {
    parent_session_id: "s1",
    id: "child-shared",
    name: "coding",
    status: "unknown",
    availability: "persisted",
    messages: [
      {
        id: "cu",
        role: "user",
        text: "Child request",
        parts: [],
        tool_calls: [],
        position: { epoch: 5, turn: 1, round: 0 },
      },
      {
        id: "ca",
        role: "assistant",
        text: null,
        parts: [],
        tool_calls: [
          {
            id: "child-tool",
            name: "pwsh",
            arguments: { command: "Get-Date" },
          },
        ],
        position: { epoch: 5, turn: 1, round: 1 },
      },
      {
        id: "ct",
        role: "tool",
        text: "Child tool output",
        parts: [],
        tool_calls: [],
        call_id: "child-tool",
        tool_name: "pwsh",
        position: { epoch: 5, turn: 1, round: 1 },
      },
      {
        id: "cf",
        role: "assistant",
        text: "Child final answer",
        parts: [],
        tool_calls: [],
        position: { epoch: 5, turn: 1, round: 2 },
      },
    ],
    next_cursor: null,
    messages_truncated: false,
    receipt: null,
    usage: null,
    executions: [],
    history: null,
  };
  const backend = await nativeBackend(page, { children: [detail] });
  const selectors: any[] = [];
  await page.route("**/api/v1/sessions/s1/audit/requests", (route) => {
    const selector = route.request().postDataJSON();
    selectors.push(selector);
    return route.fulfill({
      json: {
        status: "available",
        timeline: [
          {
            epoch: 5,
            turn: 1,
            round: 2,
            sequence: 1,
            call_id: "child-provider",
            request_hash: "child-request",
            completion: "succeeded",
          },
        ],
        attempts: selector.internal_assistants
          ? []
          : [
              {
                request_hash: "child-request",
                epoch: 5,
                turn: 1,
                round: 2,
                status: "available",
                completion: "succeeded",
                delta: "CHILD_SCOPED_DELTA",
              },
            ],
      },
    });
  });
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  await page.getByTestId("trajectory-entry").first().click();
  const originalSelection = await page
    .locator('[data-testid="trajectory-entry"][data-selected="true"]')
    .textContent();
  await page.getByTestId("header-subagents").click();
  await page
    .locator(".subagent-menu-item")
    .getByRole("button", { name: "详情", exact: true })
    .click();
  const child = page.getByRole("region", { name: "子代理内容", exact: true });
  await expect(child.locator(".transcript-wrap")).toBeVisible();
  await expect(child.locator(".message-turn-container.user-turn")).toHaveCount(
    1,
  );
  await expect(
    child.locator(".message-turn-container.assistant-turn"),
  ).toHaveCount(1);
  await expect(
    child.getByText("Child final answer", { exact: true }),
  ).toBeVisible();
  await expect(child.locator(".flow-card")).toHaveCount(0);
  await expect(
    child.getByRole("textbox", { name: "消息", exact: true }),
  ).toBeDisabled();
  await expect(
    child.getByTitle("回退上一轮对话（不恢复工作区文件）"),
  ).toHaveCount(0);
  await child.locator(".tool-accordion-group-header").click();
  await child.getByTestId("tool-row").click();
  await expect(child.getByTestId("tool-payload-input")).toContainText(
    "Get-Date",
  );
  await expect(child.getByTestId("tool-payload-output")).toContainText(
    "Child tool output",
  );
  await child.getByRole("tab", { name: "轨迹", exact: true }).click();
  await expect(child.locator(".trajectory-view")).toBeVisible();
  await child
    .locator('[data-testid="trajectory-entry"][data-kind="tool"]')
    .click();
  await expect(
    child.getByRole("tab", { name: "请求增量", exact: true }),
  ).toHaveCount(0);
  await child
    .locator('[data-testid="trajectory-entry"][data-kind="model-request"]')
    .click();
  await child.getByRole("tab", { name: "请求增量", exact: true }).click();
  await expect(child.getByTestId("historical-request-diff")).toContainText(
    "CHILD_SCOPED_DELTA",
  );
  expect(selectors.at(-1)).toMatchObject({
    child_session_id: "child-shared",
    epoch: 5,
    call_id: "child-provider",
  });
  await child.getByRole("tab", { name: "对话", exact: true }).click();
  await expect(child.getByTestId("tool-payload-output")).toContainText(
    "Child tool output",
  );
  await page
    .getByRole("navigation", { name: "会话路径" })
    .getByRole("button", { name: "原生会话", exact: true })
    .click();
  await expect(child).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "轨迹", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.locator('[data-testid="trajectory-entry"][data-selected="true"]'),
  ).toHaveText(originalSelection ?? "");
  expect(
    backend.requests.some((request) =>
      request.path.startsWith("/api/v1/sessions/child-shared"),
    ),
  ).toBe(false);
  // Child inspection must not open a session socket of its own.
  expect(
    backend.sessionSockets.every(
      (socket) =>
        decodeURIComponent(new URL(socket.url()).pathname.split("/")[4]) ===
        "s1",
    ),
  ).toBe(true);
  expect(
    backend.commands.some((command) => command.method === "history.travel"),
  ).toBe(false);
});
