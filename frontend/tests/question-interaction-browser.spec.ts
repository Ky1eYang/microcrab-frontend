import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { CLIENT_TOOL_DEFINITIONS } from "../src/client/client-tools";
import type {
  ClientBinding,
  ClientInvocation,
} from "../src/client/client-tool-controller";
function record(
  mode: "blocking" | "deferred",
  paused = false,
): ClientInvocation {
  return {
    invocation_id: "question",
    parent_session_id: "s1",
    session_id: "s1",
    call_id: "c",
    tool: "ask_user_question",
    arguments: {
      blocking_mode: mode,
      questions: [
        {
          id: "q",
          question: "等待用户决定",
          options: [
            { id: "a", label: "明确方案", recommended: mode === "blocking" },
          ],
        },
      ],
    },
    epoch: 0,
    turn_id: 1,
    round_id: 1,
    catalog_digest: "frozen",
    status: paused ? "paused" : "pending",
    created_at_ms: 1,
    deadline_ms: mode === "deferred" ? 0 : 1,
    interaction: true,
    blocking_mode: mode,
    prepared: paused,
  };
}
function catalog(call: ClientInvocation): ClientBinding {
  return {
    role: "executor",
    lease_id: "lease",
    catalog_digest: "frozen",
    definitions: CLIENT_TOOL_DEFINITIONS,
    pending: [call],
    calls: [call],
  };
}
test("child question commands route through the leased parent resource", async ({
  page,
}) => {
  const child = {
    ...record("blocking"),
    session_id: "actual_child",
    invocation_id: "child_question",
  };
  const backend = await nativeBackend(page, { clientTools: catalog(child) });
  await page.goto("/#session/s1");
  await expect(page.getByText("等待用户决定", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await expect
    .poll(
      () =>
        backend.commands.find(
          (command) => command.method === "client_tools.prepare",
        )?.sessionId,
    )
    .toBe("s1");
  await page
    .getByRole("button", { name: "明确方案 推荐", exact: true })
    .click();
  await page.getByRole("button", { name: "提交", exact: true }).click();
  await expect
    .poll(
      () =>
        backend.commands.find(
          (command) => command.method === "client_tools.result",
        )?.sessionId,
    )
    .toBe("s1");
  expect(
    backend.commands.find((command) => command.method === "client_tools.result")
      ?.params.invocation_id,
  ).toBe("child_question");
  for (const method of ["client_tools.prepare", "client_tools.result"]) {
    const command = backend.commands.find(
      (command) => command.method === method,
    );
    expect(command).not.toHaveProperty("session_id");
    expect(command?.params).not.toHaveProperty("session_id");
  }
  expect(child.session_id).toBe("actual_child");
});
test("blocking question prepares only explicitly recommended complete fallback", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    clientTools: catalog(record("blocking")),
  });
  await page.goto("/#session/s1");
  await expect(page.getByText("等待用户决定", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await expect
    .poll(
      () =>
        backend.commands.find((c) => c.method === "client_tools.prepare")
          ?.params,
    )
    .toEqual({
      lease_id: "lease",
      invocation_id: "question",
      timeout_result: {
        dismissed: false,
        source: "timeout_recommendation",
        answers: [{ id: "q", option_ids: ["a"] }],
      },
    });
  expect(backend.commands.some((c) => c.method === "client_tools.result")).toBe(
    false,
  );
});
test("paused question remains user-answerable after independent wait budget elapsed", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    clientTools: catalog(record("blocking", true)),
  });
  await page.goto("/#session/s1");
  await expect(
    page.getByText("会话已暂停等待回答，执行预算暂停。仍可回答或中断。"),
  ).toBeVisible({ timeout: 30000 });
  await page
    .getByRole("button", { name: "明确方案 推荐", exact: true })
    .click();
  await page.getByRole("button", { name: "提交", exact: true }).click();
  await expect
    .poll(
      () =>
        backend.commands.find((c) => c.method === "client_tools.result")?.params
          .result,
    )
    .toEqual({ dismissed: false, answers: [{ id: "q", option_ids: ["a"] }] });
});
test("deferred question has no client timeout fallback and accepts eventual answer", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    clientTools: catalog(record("deferred")),
  });
  await page.goto("/#session/s1");
  await expect(
    page.getByText(
      "此问题延后等待，当前会话可继续运行；回答后会话将获得结果。",
    ),
  ).toBeVisible({ timeout: 30000 });
  expect(
    backend.commands.some((c) => c.method === "client_tools.prepare"),
  ).toBe(false);
  await page.getByRole("button", { name: "明确方案", exact: true }).click();
  await page.getByRole("button", { name: "提交", exact: true }).click();
  await expect
    .poll(
      () =>
        backend.commands.find((c) => c.method === "client_tools.result")?.params
          .result,
    )
    .toEqual({ dismissed: false, answers: [{ id: "q", option_ids: ["a"] }] });
});
test("running task updates show authoritative eventual result and explicit Session cancellation", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const task = {
    capabilities: { input: false },
    execution_id: 17,
    session_id: "s1",
    call_id: "tool_call",
    tool: "slow_tool",
    agent: "coding",
    mode: "build",
    status: "running",
  };
  backend.snapshot().executions = [{ ...task, status: "running" }];
  const cancelled: string[] = [];
  backend.handleSessionCommand((command, sessionId) => {
    if (command.method !== "executions.cancel") return;
    expect(sessionId).toBe("s1");
    expect(command).not.toHaveProperty("session_id");
    expect(command.params).toEqual({ execution_id: 17 });
    cancelled.push(command.method);
    return { data: { cancelled: true, execution_id: 17 } };
  });
  await page.goto("/#session/s1");
  await page.getByRole("button", { name: "Test User", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "客户端工具", exact: true }).click();
  await expect(page.getByText("正在执行 · #17", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消执行 #17", exact: true }).click();
  await expect.poll(() => cancelled).toEqual(["executions.cancel"]);
  backend.event("executions.updated", {
    items: [{ ...task, status: "succeeded", result: "late_real_result" }],
  });
  await expect(page.getByText("已完成 · #17", { exact: true })).toBeVisible();
  await page.getByText("最终结果", { exact: true }).click();
  await expect(
    page.getByText("late_real_result", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "取消执行 #17", exact: true }),
  ).toHaveCount(0);
});
