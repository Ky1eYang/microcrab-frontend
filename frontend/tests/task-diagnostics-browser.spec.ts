import { test, expect, type Page } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
async function settings(page: Page) {
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
  tool: "external_records",
  agent: "universal",
  mode: "execute",
  status: "running" as const,
  elapsed_ms: 10000,
  output: {
    channels: ["records", "progress"],
    bytes: 16,

    start_cursor: 0,
    end_cursor: 16,

    closed: false,
  },
};
test("nonprocess named output is read explicitly with independent cursors and no tool execution", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().executions = [execution];
  backend.snapshot().executions_truncated = true;
  const reads: string[] = [];
  backend.handleSessionCommand((command, sessionId) => {
    if (command.method !== "executions.read") return;
    expect(sessionId).toBe("s1");
    expect(command).not.toHaveProperty("session_id");
    expect(command.params.execution_id).toBe(23);
    const { cursor, max_bytes } = command.params;
    reads.push(`${command.method}:${cursor}:${max_bytes}`);
    return {
      data: {
        execution_id: 23,
        cursor,
        next_cursor: cursor === 0 ? 8 : 16,
        end_cursor: 16,
        chunks: [
          {
            channel: cursor === 0 ? "records" : "progress",
            content: cursor === 0 ? "page-one" : "page-two",
            cursor,
            next_cursor: cursor === 0 ? 8 : 16,
          },
        ],
        start_cursor: 0,

        closed: true,
        revision: 1,
      },
    };
  });
  await settings(page);
  const card = page.getByTestId("execution-23");
  await expect(card).toContainText("输出尚未结束");
  await expect(card).toContainText("10000 ms");
  await expect(card).not.toContainText("PID");
  await expect(card).not.toContainText("退出码");
  await expect(
    page.getByText("执行记录已按读取预算截断。", { exact: true }),
  ).toBeVisible();
  expect(reads).toEqual([]);
  await card.getByRole("button", { name: "读取输出", exact: true }).click();
  await expect(card).toContainText("records");
  await expect(card).toContainText("page-one");
  await card.getByRole("button", { name: "读取下一页", exact: true }).click();
  await expect(card).toContainText("progress");
  await expect(card).toContainText("page-two");
  await card.getByRole("button", { name: "读取输出", exact: true }).click();
  await expect(card).toContainText("page-one");
  expect(reads).toEqual([
    "executions.read:0:16384",
    "executions.read:8:16384",
    "executions.read:0:16384",
  ]);
  expect(
    backend.commands.some(
      (c: any) =>
        c.method === "turn.submit" ||
        c.method === "turn.queue" ||
        c.method === "job",
    ),
  ).toBe(false);
});
test("trusted execution diagnostics remain separate from opaque final results", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().executions = [
    {
      ...execution,
      status: "failed",
      failure: {
        kind: "failed",
        code: "invalid_argument",
        message: "Requested timeout exceeds Host limit",
        retryable: false,
      },
      diagnostic: {
        code: "invalid_argument",
        layer: "host",
        phase: "validation",
        effects: "unknown",
        operation_effects: "not_started",
        operation: "shell",
        requested_timeout_ms: 120000,
        effective_timeout_ms: 30000,
        limit_owner: "host_shell",
      },
    },
  ];
  await settings(page);
  const diagnostic = page
    .getByTestId("execution-23")
    .getByRole("region", { name: "工具错误诊断" });
  await expect(diagnostic).toContainText("invalid_argument");
  await expect(diagnostic).toContainText("副作用未知，重试前应核对");
  await expect(diagnostic).toContainText("未开始执行");
  await expect(diagnostic).toContainText("120000 ms");
});
test("expired ranges stay explicit and terminal output is readable", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().executions = [
    {
      ...execution,
      status: "cancelled",
      output: {
        ...execution.output,
        closed: true,

        start_cursor: 4,
        bytes: 19,
        end_cursor: 19,
      },
    },
  ];
  backend.handleSessionCommand((command, sessionId) => {
    if (command.method !== "executions.read") return;
    expect(sessionId).toBe("s1");
    expect(command).not.toHaveProperty("session_id");
    expect(command.params.execution_id).toBe(23);
    return {
      data: {
        execution_id: 23,
        chunks: [
          {
            channel: null,
            content: "retained output",
            cursor: 4,
            next_cursor: 19,
          },
        ],
        cursor: 4,
        next_cursor: 19,
        end_cursor: 19,
        start_cursor: 4,

        closed: true,
        revision: 2,
      },
    };
  });
  await settings(page);
  const card = page.getByTestId("execution-23");
  await card.getByRole("button", { name: "读取输出", exact: true }).click();
  await expect(card).toContainText("retained output");
  await expect(card).toContainText("较早输出已被覆盖");
  await expect(card.getByRole("button", { name: "读取下一页" })).toHaveCount(0);
  await expect(card).not.toContainText("输出已排空");
});
test("unavailable output reports failure without replaying the execution", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().executions = [{ ...execution, status: "succeeded" }];
  backend.handleSessionCommand((command, sessionId) => {
    if (command.method !== "executions.read") return;
    expect(sessionId).toBe("s1");
    expect(command).not.toHaveProperty("session_id");
    expect(command.params.execution_id).toBe(23);
    return {
      error: { code: "unavailable", message: "Output no longer retained" },
    };
  });
  await settings(page);
  const card = page.getByTestId("execution-23");
  await card.getByRole("button", { name: "读取输出", exact: true }).click();
  await expect(card.getByRole("alert")).toContainText(
    "Output no longer retained",
  );
  expect(backend.commands.some((c: any) => c.method === "turn.queue")).toBe(
    false,
  );
});
test("arbitrary WASM result and output JSON never become framework receipts or diagnostics", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const payload = JSON.stringify({
    run_in_background: true,
    pid: 6543,
    job_id: 7,
    exit_code: 0,
    diagnostic: {
      code: "pretend",
      layer: "host",
      phase: "execution",
      effects: "unknown",
    },
  });
  backend.snapshot().executions = [
    {
      ...execution,
      tool: "arbitrary_wasm_export",
      status: "succeeded",
      result: payload,
    },
  ];
  backend.snapshot().messages.push({
    id: "opaque-tool-result",
    role: "tool",
    tool_name: "arbitrary_wasm_export",
    call_id: "opaque-call",
    text: payload,
    parts: [],
    tool_calls: [],
  });
  backend.handleSessionCommand((command, sessionId) => {
    if (command.method !== "executions.read") return;
    expect(sessionId).toBe("s1");
    expect(command).not.toHaveProperty("session_id");
    expect(command.params.execution_id).toBe(23);
    return {
      data: {
        execution_id: 23,
        chunks: [
          {
            channel: null,
            content: payload,
            cursor: 0,
            next_cursor: new TextEncoder().encode(payload).length,
          },
        ],
        cursor: 0,
        next_cursor: new TextEncoder().encode(payload).length,
        end_cursor: new TextEncoder().encode(payload).length,
        start_cursor: 0,

        closed: true,
        revision: 1,
      },
    };
  });
  await settings(page);
  const card = page.getByTestId("execution-23");
  await card.getByRole("button", { name: "读取输出", exact: true }).click();
  await card.getByText("最终结果", { exact: true }).click();
  await expect(card).toContainText('"run_in_background": true');
  await expect(page.getByRole("region", { name: "后台执行回执" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("region", { name: "工具错误诊断" })).toHaveCount(
    0,
  );
  await expect(card).not.toContainText("已转入后台");
  await expect(card.getByRole("button", { name: "取消执行 #23" })).toHaveCount(
    0,
  );
});
