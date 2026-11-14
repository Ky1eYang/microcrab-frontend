import { test, expect, type Page } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
async function openExecutions(page: Page) {
  await page.goto("/#session/s1");
  await page.getByRole("button", { name: "Test User", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "客户端工具", exact: true }).click();
}
const execution = {
  capabilities: { input: false },
  execution_id: 23,
  session_id: "s1",
  call_id: "c23",
  tool: "held",
  agent: "universal",
  mode: null,
  status: "running" as const,
};
test("cancellation remains pending until authoritative settlement and preserves output access", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().executions = [execution];
  let requests = 0;
  backend.handleSessionCommand((command, sessionId) => {
    if (command.method !== "executions.cancel") return;
    requests++;
    expect(sessionId).toBe("s1");
    expect(command).not.toHaveProperty("session_id");
    expect(command.params).toEqual({ execution_id: 23 });
    return { data: { requested: true } };
  });
  await openExecutions(page);
  const card = page.getByTestId("execution-23");
  await expect(card).not.toContainText("PID");
  await card.getByRole("button", { name: "取消执行 #23", exact: true }).click();
  await expect.poll(() => requests).toBe(1);
  await expect(
    card.getByRole("button", { name: "正在取消…", exact: true }),
  ).toBeDisabled();
  await expect(card).not.toContainText("已取消");
  backend.event("executions.updated", {
    items: [{ ...execution, status: "cancelling" }],
  });
  await expect(
    card.getByRole("button", { name: "正在取消…", exact: true }),
  ).toBeDisabled();
  backend.event("executions.updated", {
    items: [
      {
        ...execution,
        status: "cancelled",
        output: {
          channels: [],
          bytes: 4,

          start_cursor: 0,
          end_cursor: 4,
          closed: true,
        },
      },
    ],
  });
  await expect(card).toContainText("已取消");
  await expect(
    card.getByRole("button", { name: "正在取消…", exact: true }),
  ).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: "读取输出", exact: true }),
  ).toBeEnabled();
  expect(
    backend.commands.some(
      (c: any) =>
        c.method === "turn.submit" ||
        c.method === "turn.queue" ||
        c.method === "session.interrupt",
    ),
  ).toBe(false);
});
test("authoritative cancelling state disables cancellation after reopen", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().executions = [{ ...execution, status: "cancelling" }];
  await openExecutions(page);
  await expect(
    page
      .getByTestId("execution-23")
      .getByRole("button", { name: "正在取消…", exact: true }),
  ).toBeDisabled();
});
test("failed cancellation is visible and can be retried without claiming cancellation", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().executions = [execution];
  let requests = 0;
  backend.handleSessionCommand((command, sessionId) => {
    if (command.method !== "executions.cancel") return;
    requests++;
    expect(sessionId).toBe("s1");
    expect(command).not.toHaveProperty("session_id");
    expect(command.params).toEqual({ execution_id: 23 });
    return {
      error: { code: "unavailable", message: "Cancellation unavailable" },
    };
  });
  await openExecutions(page);
  const card = page.getByTestId("execution-23");
  const cancel = card.getByRole("button", {
    name: "取消执行 #23",
    exact: true,
  });
  await cancel.click();
  await expect(card.getByRole("alert")).toContainText(
    "Cancellation unavailable",
  );
  await expect(cancel).toBeEnabled();
  await expect(card).not.toContainText("已取消");
  expect(requests).toBe(1);
});
