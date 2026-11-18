import { test, expect } from "@playwright/test";
import { connectHostUI } from "./host-fixture";
import { nativeBackend } from "./native-fixture";

test("HTTP lifecycle and settings retain WS turns, direct Host connection and canonical subscriptions", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await connectHostUI(page);
  await page.getByTestId("composer-agent-pill").click();
  await page.getByRole("menuitemradio", { name: "build", exact: true }).click();
  await expect
    .poll(
      () =>
        backend.requests.find(
          (request) =>
            request.method === "PUT" &&
            request.path === "/api/v1/sessions/s1/mode",
        )?.body.mode,
    )
    .toBe("build");
  await page.getByLabel("消息", { exact: true }).fill("new prompt");
  await page.getByTitle("发送 (Enter)").click();
  await expect
    .poll(
      () =>
        backend.commands.filter((command) => command.method === "turn.queue")
          .length,
    )
    .toBe(1);
  // Reconnects open a new session socket; the first turn grows the count.
  await expect.poll(() => backend.sessionSockets.length).toBeGreaterThan(1);
  backend.event("model_observation", {
    operation_id: "op1",
    call_id: "call1",
    phase: "started",
  });
  backend.event("model_observation", {
    operation_id: "op1",
    call_id: "call1",
    phase: "text_delta",
    text: "temporary preview",
  });
  await expect(
    page.getByText("temporary preview", { exact: true }),
  ).toBeVisible();
  backend.finish("canonical final");
  backend.event("turn", { id: "op1", status: "completed" });
  await expect(
    page.getByText("canonical final", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("temporary preview", { exact: true }),
  ).toHaveCount(0);
  expect(
    backend.http.every((path) =>
      [
        "/api/auth/session",
        "/api/v1/capabilities",
        "/api/v1/projects",
        "/api/v1/models",
        "/api/v1/sessions",
        "/api/v1/settings",
        "/api/v1/projects/project-1/settings",
        "/api/v1/projects/project-1/agents",
        "/api/v1/projects/project-1/host/connect",
        "/api/v1/sessions/s1/runtime",
        "/api/v1/sessions/s1/mode",
      ].includes(path),
    ),
  ).toBe(true);
  expect(
    backend.commands.every(
      (command) =>
        // Session commands arrive on the session socket and stay recorded in
        // `commands`; subscription itself is the socket, not a command.
        ["turn.queue", "sessions.watch", "host.relay_attach"].includes(
          command.method,
        ) &&
        command.v === 1 &&
        command.type === "command" &&
        command.request_id &&
        command.params,
    ),
  ).toBe(true);
});

test("gap resync and socket reconnect discard previews and never replay submit", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  backend.event("model_observation", {
    operation_id: "op1",
    call_id: "call1",
    phase: "text_delta",
    text: "drop on gap",
  });
  await expect(page.getByText("drop on gap", { exact: true })).toBeVisible();
  const subscriptions = backend.sessionSockets.length;
  backend.event("session", backend.snapshot().session, 2);
  await expect
    .poll(() => backend.sessionSockets.length)
    .toBeGreaterThan(subscriptions);
  await expect(page.getByText("drop on gap", { exact: true })).toHaveCount(0);
  backend.sockets.at(-1)!.close({ code: 1012, reason: "restart" });
  await expect.poll(() => backend.sockets.length).toBe(2);
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  expect(
    backend.commands.filter((command) => command.method === "turn.queue"),
  ).toHaveLength(0);
});

test("restored management preserves charts and labels unsupported sample data", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await page.goto("/#dashboard");
  await expect(page.getByTestId("dashboard-unsupported-notice")).toContainText(
    "原版演示数据",
  );
  await expect(
    page.getByRole("tab", { name: "概况", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "缓存命中率", exact: true }).click();
  await page.getByTitle("刷新数据").click();
  await expect(page.locator(".toast-body")).toContainText("[unsupported] TODO");
  expect(
    backend.http.some((path) =>
      /\/api\/(?:v1\/)?(?:admin|dashboard)\//.test(path),
    ),
  ).toBe(false);
});

test("projectless workspace selection reports missing runtime assets without a Project fallback", async ({
  page,
}) => {
  const backend = await nativeBackend(page, { selectProject: false });
  await page.route("**/browser-host/current.json", (route) =>
    route.fulfill({ status: 404, body: "not installed" }),
  );
  await page.goto("/");
  await expect(page.getByTitle("选择项目工作区")).toContainText("仅聊天");
  await expect(page.locator(".composer-model-pill")).toContainText(
    "Configured model",
  );
  await expect(page.getByLabel("消息", { exact: true })).toBeEnabled();
  await expect(page.locator(".composer-offline-banner")).toHaveCount(0);
  await page.getByTitle("选择项目工作区").click();
  await page.locator('[data-host-flavor="browser_sandbox"]').click();
  await expect(page.getByTitle("选择项目工作区")).toContainText("沙盒");
  await expect(page.locator(".composer-plus-btn")).toBeVisible();
  await expect(page.locator(".composer-model-pill")).toContainText(
    "Configured model",
  );
  await expect(page.locator(".composer-left-actions select")).toHaveCount(0);
  await expect(page.getByTestId("header-host-connection")).toHaveCount(0);
  await expect(page.locator(".composer-offline-banner")).toContainText(
    "浏览器工作区暂不可用",
  );
  await expect(page.locator(".toast-body")).toContainText(
    "浏览器 Host 运行时资源尚未安装",
  );
  await expect(page.getByTitle("选择项目工作区")).not.toContainText("Assigned");
  expect(
    backend.commands.filter(
      (command) => command.method === "conversation.binding",
    ),
  ).toHaveLength(2);
  expect(
    backend.commands
      .filter((command) => command.method === "conversation.binding")
      .map((command) => command.params.host_flavor),
  ).toEqual(["chat_only", "browser_sandbox"]);
  expect(
    backend.commands.filter((command) => command.method === "session.create"),
  ).toHaveLength(0);
  await page.getByTitle("选择项目工作区").click();
  await page.getByTestId("picker-create-project").click();
  await expect(page.locator("#host-project-name")).toBeVisible();
  await expect(page.locator(".remote-connect-dialog")).toBeVisible();
  expect(
    backend.http.some((path) =>
      /\/api\/(?:v1\/)?(?:setup|sandbox)\//.test(path),
    ),
  ).toBe(false);
});
