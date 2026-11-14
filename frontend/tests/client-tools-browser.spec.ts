import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { CLIENT_TOOL_DEFINITIONS } from "../src/client/client-tools";
import type {
  ClientBinding,
  ClientInvocation,
} from "../src/client/client-tool-controller";
const question: ClientInvocation = {
  invocation_id: "question_inv",
  parent_session_id: "s1",
  session_id: "s1",
  call_id: "model_call",
  tool: "ask_user_question",
  arguments: {
    questions: [
      {
        id: "choice",
        header: "选项",
        question: "选择方案",
        multiple: true,
        options: [
          { id: "one", label: "重复标签", description: "第一项" },
          { id: "two", label: "重复标签", description: "第二项" },
        ],
      },
    ],
  },
  epoch: 0,
  turn_id: 1,
  round_id: 1,
  catalog_digest: "frozen_digest",
  created_at_ms: 1,
  deadline_ms: Date.now() + 300000,
  status: "pending",
};
function binding(role: "executor" | "observer"): ClientBinding {
  return {
    role,
    lease_id: role === "executor" ? "lease_1" : undefined,
    catalog_digest: "frozen_digest",
    definitions: CLIENT_TOOL_DEFINITIONS,
    pending: [question],
    calls: [question],
  };
}
test("reclaimed browser question preserves stable IDs across options and custom answer", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    clientTools: binding("executor"),
  });
  await page.goto("/#session/s1");
  await expect(page.getByText("选择方案", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await page.getByRole("button", { name: "重复标签 第一项" }).click();
  await page.getByRole("button", { name: "重复标签 第二项" }).click();
  await page
    .getByRole("textbox", { name: "选项：自定义回答" })
    .fill("额外回答");
  await page.getByRole("button", { name: "提交", exact: true }).click();
  await expect
    .poll(
      () =>
        backend.commands.find(
          (command) => command.method === "client_tools.result",
        )?.params,
    )
    .toEqual({
      lease_id: "lease_1",
      invocation_id: "question_inv",
      result: {
        dismissed: false,
        answers: [
          { id: "choice", option_ids: ["one", "two"], custom: "额外回答" },
        ],
      },
    });
  await expect(page.getByText("选择方案", { exact: true })).toHaveCount(0);
});
test("observer question controls are read-only and executor can dismiss explicitly", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    clientTools: binding("observer"),
  });
  await page.goto("/#session/s1");
  await expect(
    page.getByText("其他客户端正在处理此问题，此窗口仅供观察。"),
  ).toBeVisible({ timeout: 30000 });
  await expect(
    page.getByRole("button", { name: "忽略", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("textbox", { name: "选项：自定义回答" }),
  ).toBeDisabled();
  expect(
    backend.commands.some(
      (command) => command.method === "client_tools.result",
    ),
  ).toBe(false);
});
test("executor dismissal uses explicit durable result and original lease", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    clientTools: binding("executor"),
  });
  await page.goto("/#session/s1");
  await page.getByRole("button", { name: "忽略", exact: true }).click();
  await expect
    .poll(
      () =>
        backend.commands.find(
          (command) => command.method === "client_tools.result",
        )?.params.result,
    )
    .toEqual({ dismissed: true, answers: [] });
});

test("pending questions retain invocation order across later input and reload", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    clientTools: binding("observer"),
  });
  backend.snapshot().messages = [
    {
      id: "start",
      role: "user",
      text: "开始问答",
      parts: [],
      tool_calls: [],
      position: { epoch: 0, turn: 1, round: 0 },
    },
    {
      id: "question",
      role: "assistant",
      text: "调用问答卡",
      parts: [],
      tool_calls: [
        {
          id: question.call_id,
          name: question.tool,
          arguments: question.arguments,
        },
      ],
      position: { epoch: 0, turn: 1, round: 1 },
    },
    {
      id: "answer",
      role: "assistant",
      text: "问答卡之后的回复",
      parts: [],
      tool_calls: [],
      position: { epoch: 0, turn: 1, round: 2 },
    },
    {
      id: "next",
      role: "user",
      text: "后续用户输入",
      parts: [],
      tool_calls: [],
      position: { epoch: 0, turn: 2, round: 0 },
    },
  ];
  await page.goto("/#session/s1");
  const assertOrder = async () => {
    await expect(page.getByText("选择方案", { exact: true })).toBeVisible();
    const text = await page.locator(".transcript-inner").innerText();
    expect(text.indexOf("调用问答卡")).toBeLessThan(text.indexOf("选择方案"));
    expect(text.indexOf("选择方案")).toBeLessThan(
      text.indexOf("问答卡之后的回复"),
    );
    expect(text.indexOf("问答卡之后的回复")).toBeLessThan(
      text.indexOf("后续用户输入"),
    );
    await expect(
      page.locator(".conversation-input-anchor .flow-card"),
    ).toHaveCount(0);
  };
  await assertOrder();
  await page.reload();
  await assertOrder();
});
