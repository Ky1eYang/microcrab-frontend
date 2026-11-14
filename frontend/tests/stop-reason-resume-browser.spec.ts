import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import type { NativeDisplayRecord } from "../src/client/types";

const graphFixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/display-block-graph.json", import.meta.url),
    "utf8",
  ),
) as { frames: NativeDisplayRecord[] };

test("cancelled Host receipt shows a neutral chat notice and empty cancelled request preview", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const snapshot = backend.snapshot();
  snapshot.session.status = "running";
  snapshot.messages = [
    {
      id: "user",
      role: "user",
      text: "Stop reason regression",
      parts: [],
      tool_calls: [],
      position: { epoch: 0, turn: 1, round: 0 },
    },
  ];
  await page.route("**/api/v1/sessions/s1/audit/requests", (route) =>
    route.fulfill({
      json: {
        status: "ok",
        committed_sequence: 1,
        incomplete_tail: false,
        attempts: [],
        timeline: [
          {
            sequence: 1,
            request_hash: "cancelled-request",
            call_id: "retry",
            epoch: 0,
            turn: 1,
            round: 1,
            branch_selected: true,
            completion: "cancelled",
            cancel_reason: "cancelled",
          },
        ],
        stages: [],
      },
    }),
  );
  await page.goto("/#session/s1");
  await expect(
    page.getByText("Stop reason regression", { exact: true }),
  ).toBeVisible();
  // These identities, byte offsets and ancestry come from the native recorder.
  for (const record of graphFixture.frames)
    backend.event("model_observation", {
      ...record.event,
      archive_sequence: record.sequence,
      attempt_id: record.attempt_id,
    });
  const thinking = page.getByTestId("think-block");
  await expect(thinking).not.toHaveCount(0);
  const thinkingCount = await thinking.count();
  backend.event("turn", {
    id: "host-stop",
    session_id: "s1",
    method: "turn.inbox",
    status: "cancelled",
    updated_at_ms: 10,
    result: {
      after_message_id: "user",
      position: { epoch: 0, turn: 1, round: 1 },
      error: {
        code: "cancelled",
        message: "Interrupted because the Host connection was detached",
        details: {
          cancel_reason: "host_detached",
          detail: "Host connection detached",
        },
      },
    },
  });
  const notice = page.getByTestId("operation-failure");
  await expect(notice).toContainText("Host 连接断开，操作已中断");
  await expect(notice.locator("xpath=ancestor::article")).toHaveAttribute(
    "data-stream",
    "cancelled",
  );
  await expect(notice.locator("xpath=ancestor::article")).not.toHaveClass(
    /block-stream-error/,
  );
  await expect(thinking).toHaveCount(thinkingCount);
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  const cancelledRequest = page
    .getByTestId("trajectory-entry")
    .filter({ hasText: "模型输入" });
  await expect(cancelledRequest.first()).toHaveAttribute(
    "data-status",
    "cancelled",
  );
  await cancelledRequest.first().click();
  const inspector = page.getByTestId("trajectory-inspector");
  await inspector.getByRole("tab", { name: "预览", exact: true }).click();
  await expect(inspector).toContainText("操作已取消");
  await expect(inspector).not.toContainText("(无内容)");
});

test("actual store same-ready select and create preserve gRPC without lifecycle requests", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await page.goto("/");
  await expect(page.getByTestId("header-host-connection")).toBeVisible();
  const requests: { path: string; trigger?: string; tab?: string }[] = [];
  page.on("request", (request) => {
    if (/\/host\/(connect|disconnect)$/.test(new URL(request.url()).pathname))
      requests.push({
        path: new URL(request.url()).pathname,
        trigger: request.headers()["x-client-trigger"],
        tab: request.headers()["x-client-tab-id"],
      });
  });
  await page.evaluate(async () => {
    const { AppStore } = await import("/src/state/store.ts");
    const store: any = new AppStore();
    const projects = await store.api.request("project.list", {});
    const project = projects.items[0];
    await store.api.connectHost(
      project.id,
      "http://127.0.0.1:8788/host",
      undefined,
      () => {},
      { directory: project.root, trigger: "resume_project:bootstrap" },
    );
    store.update({
      projects: projects.items,
      authSession: { authenticated: true, principal: { owner: "u1" } },
      draftWorkspace: {
        kind: "local",
        projectId: project.id,
        path: project.root,
        label: project.name,
      },
      agents: [{ name: "coding", modes: [], tools: [] }],
      hostConnection: {
        projectId: project.id,
        state: "ready",
        connected: true,
        transport: "grpc",
      },
    });
    await store.dispatch({ type: "SelectKnownProject", value: project.id });
    await store.dispatch({ type: "CreateSessionInProject", value: project.id });
    store.api.stop();
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].path).toMatch(/\/host\/connect$/);
  expect(requests[0].trigger).toBe("resume_project:bootstrap");
  expect(requests[0].tab).toMatch(/^[0-9a-f-]{36}$/);
  expect(
    backend.requests.filter((request) =>
      request.path.endsWith("/host/disconnect"),
    ),
  ).toHaveLength(0);
});
