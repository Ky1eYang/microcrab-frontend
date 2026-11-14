import { test, expect, type Page } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { connectHostUI } from "./host-fixture";
import { CLIENT_TOOL_DEFINITIONS } from "../src/client/client-tools";
import type { ClientBinding } from "../src/client/client-tool-controller";
import type { NativeChildDetail, PermissionRequest } from "../src/client/types";

function binding(role: "executor" | "observer" = "executor"): ClientBinding {
  return {
    role,
    lease_id: role === "executor" ? "lease_permission" : undefined,
    catalog_digest: "permission_digest",
    definitions: CLIENT_TOOL_DEFINITIONS,
    calls: [],
    pending: [],
  };
}
function request(id = "permission-1", session = "s1"): PermissionRequest {
  return {
    request_id: id,
    parent_session_id: "s1",
    session_id: session,
    call_id: "native-call",
    agent: "coding",
    mode: "execute",
    tool: "shell",
    arguments: { command: "echo permission" },
    revision: 4,
    created_at_ms: Date.now(),
    expires_at_ms: Date.now() + 300000,
  };
}
function child(
  availability: NativeChildDetail["availability"] = "persisted",
): NativeChildDetail {
  return {
    parent_session_id: "s1",
    id: "child-native-1",
    name: "coding",
    status: "unknown",
    availability,
    messages:
      availability === "persisted"
        ? [
            {
              id: "child-message-1",
              role: "assistant",
              text: "实际子代理历史",
              parts: [],
              tool_calls: [],
            },
          ]
        : [],
    next_cursor: null,
    messages_truncated: false,
    receipt: null,
    usage: null,
    executions: [],
    history: null,
  };
}
async function ready(page: Page) {
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
}

test("initialization approval displays component trust and exact attempt scope", async ({
  page,
}) => {
  await nativeBackend(page, {
    clientTools: binding(),
    permissionRequests: [
      {
        ...request(),
        tool: "",
        subject: {
          kind: "agent_init",
          component: "coding.component",
          generation: 3,
          attempt: 7,
        },
        arguments: {
          component: "coding.component",
          operations: ["filesystem.read", "process.execute"],
        },
      },
    ],
  });
  await ready(page);
  const card = page.getByTestId("permission-request");
  await expect(card.getByRole("heading")).toContainText(
    "组件初始化审批 · coding.component",
  );
  await expect(card).toContainText("本次审批信任组件");
  await card.locator("summary").click();
  await expect(card.getByTestId("permission-request-payload")).toContainText(
    "process.execute",
  );
  await expect(card.getByTestId("permission-request-payload")).toContainText(
    '"attempt": 7',
  );
});

test("permission Ask uses current executor lease once and child requests reply through parent", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    clientTools: binding(),
    permissionRequests: [request("child-ask", "child-native-1")],
    holdPermissionReply: true,
  });
  await ready(page);
  const card = page.getByTestId("permission-request");
  await expect(
    page.locator(
      ".conversation-input-anchor [data-testid='permission-request']",
    ),
  ).toHaveCount(1);
  await expect(
    page.locator(".transcript-inner [data-testid='permission-request']"),
  ).toHaveCount(0);
  await expect(card).toContainText("子代理 child-native-1");
  await expect(card.getByText("仅限本次调用，不保存授权。")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Always|总是|永久/ }),
  ).toHaveCount(0);
  await card.getByRole("button", { name: "允许本次", exact: true }).click();
  await expect(
    card.getByRole("button", { name: "允许本次", exact: true }),
  ).toBeDisabled();
  await expect(
    card.getByRole("button", { name: "拒绝", exact: true }),
  ).toBeDisabled();
  await expect
    .poll(
      () =>
        backend.commands.filter(
          (command) => command.method === "permission.reply",
        ).length,
    )
    .toBe(1);
  const reply = backend.commands.find(
    (command) => command.method === "permission.reply",
  );
  expect(reply).not.toHaveProperty("session_id");
  expect(reply.sessionId).toBe("s1");
  expect(reply.params).toEqual({
    request_id: "child-ask",
    lease_id: "lease_permission",
    decision: "allow",
  });
  backend.releasePermissionReply();
  await expect(card).toHaveCount(0);
  expect(
    backend.commands.filter((command) => command.method === "permission.reply"),
  ).toHaveLength(1);
  expect(
    backend.requests.some(
      (item) => item.method === "PUT" && item.path.endsWith("/permission"),
    ),
  ).toBe(false);
});

test("permission observer sees the real request but cannot allow or deny", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    clientTools: binding("observer"),
    permissionRequests: [request()],
  });
  await ready(page);
  const card = page.getByTestId("permission-request");
  await expect(card).toContainText("仅供查看，请在执行客户端回复。");
  await expect(
    card.getByRole("button", { name: "允许本次", exact: true }),
  ).toBeDisabled();
  await expect(
    card.getByRole("button", { name: "拒绝", exact: true }),
  ).toBeDisabled();
  expect(
    backend.commands.filter((command) => command.method === "permission.reply"),
  ).toHaveLength(0);
});

test("ordered permission cancellation clears the card and duplicate settlement does not revive it", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    clientTools: binding(),
    permissionRequests: [],
  });
  await ready(page);
  await expect
    .poll(
      () =>
        backend.commands.filter(
          (command) => command.method === "client_tools.bind",
        ).length,
    )
    .toBe(1);
  const ask = request();
  backend.pendingPermissions.push(ask);
  backend.event("permission.requested", { request: ask });
  await expect(page.getByTestId("permission-request")).toBeVisible();
  const settled = {
    request_id: ask.request_id,
    parent_session_id: "s1",
    session_id: "s1",
    decision: "deny",
    reason: "cancelled",
    remembered: false,
  };
  backend.pendingPermissions.splice(0);
  backend.event("permission.settled", settled);
  await expect(page.getByTestId("permission-request")).toHaveCount(0);
  backend.event("permission.settled", settled);
  backend.event("permission.requested", { request: ask });
  await expect(page.getByTestId("permission-request")).toHaveCount(0);
  expect(
    backend.commands.filter((command) => command.method === "permission.reply"),
  ).toHaveLength(0);
});

test("attach-time pending permissions cannot resurrect an authoritatively settled request", async ({
  page,
}) => {
  const ask = request();
  const backend = await nativeBackend(page, {
    clientTools: binding(),
    permissionRequests: [ask],
  });
  await ready(page);
  // The pending snapshot rides in the attach result, ordered before live events.
  await expect(page.getByTestId("permission-request")).toBeVisible();
  backend.event("permission.settled", {
    request_id: ask.request_id,
    parent_session_id: "s1",
    session_id: "s1",
    decision: "deny",
    reason: "deadline",
    remembered: false,
  });
  await expect(page.getByTestId("permission-request")).toHaveCount(0);
  const snapshot = structuredClone(backend.snapshot());
  snapshot.session.title = "After settlement";
  backend.publish(snapshot);
  await expect(
    page.getByTestId("session-item").filter({ hasText: "After settlement" }),
  ).toBeVisible();
  await expect(page.getByTestId("permission-request")).toHaveCount(0);
  expect(
    backend.requests.filter((item) => item.path.includes("/permission/")),
  ).toHaveLength(0);
});

test("expired Ask is disabled and a websocket disconnect removes permission authority", async ({
  page,
}) => {
  const expired = { ...request(), expires_at_ms: Date.now() - 1 };
  const backend = await nativeBackend(page, {
    clientTools: binding(),
    permissionRequests: [expired],
  });
  await ready(page);
  await expect(page.getByTestId("permission-request")).toContainText(
    "请求已过期",
  );
  await expect(
    page.getByRole("button", { name: "允许本次", exact: true }),
  ).toBeDisabled();
  backend.pendingPermissions.splice(0);
  backend.sockets.at(-1)!.close();
  await expect(page.getByTestId("permission-request")).toHaveCount(0);
  expect(
    backend.commands.filter((command) => command.method === "permission.reply"),
  ).toHaveLength(0);
});

test("native delegate child_id opens parent-scoped read-only detail without child attach", async ({
  page,
}) => {
  const backend = await nativeBackend(page, { children: [child()] });
  backend.snapshot().messages.push(
    {
      id: "delegate-call",
      role: "assistant",
      text: null,
      parts: [],
      tool_calls: [
        {
          id: "delegate-1",
          name: "delegate",
          arguments: { subagent: "coding", prompt: "Inspect child" },
        },
      ],
    },
    {
      id: "delegate-result",
      role: "tool",
      text: JSON.stringify({ child_id: "child-native-1", result: "done" }),
      parts: [],
      tool_calls: [],
      call_id: "delegate-1",
      tool_name: "delegate",
    },
  );
  await ready(page);
  await page.getByTestId("header-subagents").click();
  await expect
    .poll(() =>
      backend.requests.some(
        (item) => item.path === "/api/v1/sessions/s1/children",
      ),
    )
    .toBe(true);
  await page
    .locator(".subagent-menu-item")
    .getByRole("button", { name: "详情", exact: true })
    .click();
  const dialog = page.getByRole("region", { name: "子代理内容", exact: true });
  await expect(dialog).toContainText("实际子代理历史");
  await expect(dialog.getByTestId("child-detail-status")).toContainText(
    "状态未确认",
  );
  expect(
    backend.requests.some(
      (item) => item.path === "/api/v1/sessions/s1/children/child-native-1",
    ),
  ).toBe(true);
  // Child inspection must not open a session socket of its own.
  expect(
    backend.sessionSockets.every(
      (socket) =>
        decodeURIComponent(new URL(socket.url()).pathname.split("/")[4]) ===
        "s1",
    ),
  ).toBe(true);
  expect(
    backend.requests.some((item) =>
      item.path.startsWith("/api/v1/sessions/child-native-1"),
    ),
  ).toBe(false);
  await expect(page.getByRole("dialog", { name: "子代理详情" })).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "会话路径" }),
  ).toContainText("coding");
  await page
    .getByRole("navigation", { name: "会话路径" })
    .getByRole("button", { name: "原生会话", exact: true })
    .click();
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
});

test("pending child history is explicit and pagination remains under its parent", async ({
  page,
}) => {
  const detail = child("pending");
  const backend = await nativeBackend(page, { children: [detail] });
  await ready(page);
  await page.getByTestId("header-subagents").click();
  await expect(page.locator(".subagent-menu-item")).toHaveCount(1);
  await page
    .locator(".subagent-menu-item")
    .getByRole("button", { name: "详情", exact: true })
    .click();
  const dialog = page.getByRole("region", { name: "子代理内容", exact: true });
  await expect(dialog).toContainText("等待历史提交");
  await expect(dialog.locator(".message-turn-container")).toHaveCount(0);
  Object.assign(detail, child(), {
    next_cursor: 5,
    messages_truncated: true,
    executions_truncated: true,
    history_view: {
      lineage: "child-pending-lineage",
      epoch: 0,
      start_cursor: 5,
      end_cursor: 7,
      message_count: 7,
      turns: [],
    },
  });
  detail.messages.push({
    id: "omitted-child-message",
    role: "assistant",
    text: null,
    parts: [],
    tool_calls: [],
    content_omitted: true,
  });
  await dialog.getByRole("button", { name: "刷新记录", exact: true }).click();
  await expect(dialog).toContainText("执行记录已按读取预算截断");
  await expect(dialog).toContainText("此消息内容超出读取预算");
  await expect(dialog.getByTestId("conversation-load-earlier")).toBeVisible();
  detail.messages = [
    {
      id: "older-message",
      role: "user",
      text: "更早的子代理消息",
      parts: [],
      tool_calls: [],
    },
  ];
  detail.messages.push(
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `older-child-evidence-${index}`,
      role: "assistant" as const,
      text: `Earlier child record ${index}`,
      parts: [],
      tool_calls: [],
    })),
  );
  detail.history_view = {
    lineage: "child-pending-lineage",
    epoch: 0,
    start_cursor: 0,
    end_cursor: 5,
    message_count: 7,
    turns: [],
  };
  detail.messages_truncated = false;
  detail.next_cursor = null;
  await dialog.getByTestId("conversation-load-earlier").click();
  await expect(dialog).toContainText("更早的子代理消息");
  await expect(dialog).toContainText("实际子代理历史");
  expect(
    backend.requests.some(
      (item) =>
        item.path === "/api/v1/sessions/s1/children/child-native-1" &&
        item.query.before_cursor === "5",
    ),
  ).toBe(true);
});

test("unauthorized child detail stays an error under the parent without fallback attach", async ({
  page,
}) => {
  const backend = await nativeBackend(page, { children: [child()] });
  await page.route("**/api/v1/sessions/s1/children/child-native-1*", (route) =>
    route.fulfill({
      status: 403,
      json: { error: { code: "unavailable", message: "Child unavailable" } },
    }),
  );
  await ready(page);
  await page.getByTestId("header-subagents").click();
  await expect(page.locator(".subagent-menu-item")).toHaveCount(1);
  await page
    .locator(".subagent-menu-item")
    .getByRole("button", { name: "详情", exact: true })
    .click();
  const dialog = page.getByRole("region", { name: "子代理内容", exact: true });
  await expect(dialog.getByRole("alert")).toContainText("Child unavailable");
  await expect(dialog.locator(".message-turn-container")).toHaveCount(0);
  // Child inspection must not open a session socket of its own.
  expect(
    backend.sessionSockets.every(
      (socket) =>
        decodeURIComponent(new URL(socket.url()).pathname.split("/")[4]) ===
        "s1",
    ),
  ).toBe(true);
});

test("structured delegate labels and status cannot crash child navigation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const backend = await nativeBackend(page, { children: [child()] });
  backend.snapshot().messages.push(
    {
      id: "bad-delegate",
      role: "assistant",
      text: null,
      parts: [],
      tool_calls: [
        {
          id: "bad-call",
          name: "delegate",
          arguments: {
            subagent: { unexpected: "object" },
            prompt: { unexpected: "prompt" },
          },
        },
      ],
    },
    {
      id: "bad-result",
      role: "tool",
      text: JSON.stringify({
        child_id: "child-native-1",
        status: { state: "done" },
      }),
      parts: [],
      tool_calls: [],
      call_id: "bad-call",
      tool_name: "delegate",
    },
  );
  await ready(page);
  await page.getByTestId("header-subagents").click();
  await expect(page.locator(".subagent-menu-item")).toHaveCount(1);
  await page
    .locator(".subagent-menu-item")
    .getByRole("button", { name: "详情", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "子代理内容", exact: true }),
  ).toContainText("实际子代理历史");
  expect(errors).toEqual([]);
  // Child inspection must not open a session socket of its own.
  expect(
    backend.sessionSockets.every(
      (socket) =>
        decodeURIComponent(new URL(socket.url()).pathname.split("/")[4]) ===
        "s1",
    ),
  ).toBe(true);
});

test("return breadcrumb fences a late child response and preserves parent draft", async ({
  page,
}) => {
  await nativeBackend(page, { children: [child()] });
  let release: (() => Promise<void>) | undefined;
  await page.route(
    "**/api/v1/sessions/s1/children/child-native-1*",
    (route) => {
      release = () => route.fulfill({ json: child() });
    },
  );
  await ready(page);
  await connectHostUI(page);
  const input = page.locator("textarea").first();
  await input.fill("keep parent draft");
  await page.getByTestId("header-subagents").click();
  await page
    .locator(".subagent-menu-item")
    .getByRole("button", { name: "详情", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "子代理内容", exact: true }),
  ).toContainText("正在读取");
  await expect(
    page
      .getByRole("region", { name: "子代理内容", exact: true })
      .getByText("历史回答", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "子代理内容", exact: true })
      .getByRole("textbox", { name: "消息", exact: true }),
  ).toBeDisabled();
  await expect.poll(() => !!release).toBe(true);
  await page
    .getByRole("navigation", { name: "会话路径" })
    .getByRole("button", { name: "原生会话", exact: true })
    .click();
  await release!();
  await expect(
    page.getByRole("region", { name: "子代理内容", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await expect(input).toHaveValue("keep parent draft");
});
