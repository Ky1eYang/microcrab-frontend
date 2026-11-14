import { expect, test } from "@playwright/test";
import type { NativeOperation } from "../src/client/types";
import { nativeBackend, nativeSnapshot } from "./native-fixture";
import { connectHostUI } from "./host-fixture";

test("admission rejection preserves its actual error and draft without fabricating a model failure", async ({
  page,
}) => {
  const reason = "Project Host unavailable (HTTP 502)";
  const backend = await nativeBackend(page, {
    extraMethods: ["turn.retry"],
    submitError: { code: "host_unavailable", message: reason },
  });
  Object.assign(backend.snapshot(), {
    ...structuredClone(nativeSnapshot),
    messages: [],
    operations: [],
  });
  await page.goto("/#session/s1");
  await connectHostUI(page);
  const composer = page.getByTestId("composer").locator("textarea");
  await expect(composer).toBeEnabled();
  await composer.fill("Preserve this unadmitted draft");
  await page.getByTitle("发送 (Enter)", { exact: true }).click();
  await expect(
    page.getByText(`发送失败：${reason}`, { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('.toast-container[data-kind="error"]'),
  ).toContainText(`发送失败：${reason}`);
  await expect(composer).toHaveValue("Preserve this unadmitted draft");
  await expect(page.getByText("请求未能成功响应", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByTestId("retry-model-request")).toHaveCount(0);
  await expect(page.locator(".message-turn-container.user-turn")).toHaveCount(
    0,
  );
  expect(backend.snapshot().messages).toHaveLength(0);
  expect(
    backend.commands.filter((command) => command.method === "turn.queue"),
  ).toHaveLength(1);
});

test("a live terminal model failure binds retry after invalidation and bounded receipt refresh, then reload", async ({
  page,
}) => {
  const backend = await nativeBackend(page, { extraMethods: ["turn.retry"] });
  Object.assign(backend.snapshot(), {
    ...structuredClone(nativeSnapshot),
    messages: [],
    operations: [],
  });
  await page.goto("/#session/s1");
  await connectHostUI(page);
  const composer = page.getByTestId("composer").locator("textarea");
  await expect(composer).toBeEnabled();
  await composer.fill("A new admitted model failure");
  await page.getByTitle("发送 (Enter)", { exact: true }).click();
  await expect(
    page.getByTitle("请求中断，等待实际终态", { exact: true }),
  ).toBeEnabled();
  const submit = backend.commands.find(
    (command) => command.method === "turn.queue",
  );
  expect(submit).toBeDefined();
  const id = submit.params.operation_id;
  const position = { epoch: 0, turn: 1, round: 1 };
  const observation = { operation_id: id, call_id: "model-call", ...position };
  backend.event("model_observation", { ...observation, phase: "started" });
  backend.event("model_observation", {
    ...observation,
    phase: "reasoning_delta",
    text: "Retained failed thinking",
  });
  backend.event("model_observation", {
    ...observation,
    phase: "text_delta",
    text: "Retained failed partial",
  });
  await expect(
    page.getByText("Retained failed partial", { exact: true }),
  ).toBeVisible();
  backend.event("model_observation", { ...observation, phase: "invalidated" });
  const failure: NativeOperation = {
    version: 1,
    id,
    session_id: "s1",
    owner: "u1",
    method: "turn.inbox",
    payload_hash: "fixture",
    status: "failed",
    revision: 1,
    created_at_ms: 100,
    updated_at_ms: 101,
    result: {
      error: {
        code: "provider_error",
        message: "Provider unavailable after retries",
      },
      position,
      after_message_id: `user-${id}`,
      retry_ready: true,
      partial_output: {
        call_id: "model-call",
        ...position,
        text: "Retained failed partial",
        reasoning: "Retained failed thinking",
      },
    },
  };
  const older = Array.from({ length: 31 }, (_, index) => ({
    ...failure,
    id: `metadata-${index}`,
    method: "session.rename",
    status: "completed" as const,
    created_at_ms: 31 - index,
    updated_at_ms: 31 - index,
    result: null,
  }));
  const snapshot = backend.snapshot();
  snapshot.session = {
    ...snapshot.session,
    revision: snapshot.session.revision + 1,
    status: "idle",
    retry_ready: true,
    retry_operation_id: id,
  };
  snapshot.messages[0].position = position;
  snapshot.operations = [failure, ...older];
  snapshot.operations_truncated = true;
  backend.event("turn", failure);
  backend.publish(snapshot);
  const check = async () => {
    await expect(
      page.getByText("Retained failed partial", { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("incomplete-output")).toHaveCount(2);
    await expect(
      page.locator('[data-testid="chat-message"][data-stream="stopped"]'),
    ).toHaveCount(2);
    await expect(
      page.getByText("请求未能成功响应", { exact: true }),
    ).toHaveCount(1);
    const retry = page.getByTestId("retry-model-request");
    await expect(retry).toHaveAttribute("data-operation-id", id);
    await page
      .locator(".message-turn-container.assistant-turn")
      .filter({ has: retry })
      .hover();
    await expect(retry).toBeVisible();
    await expect(retry).toBeEnabled();
  };
  await check();
  backend.publish(snapshot);
  await check();
  await page.reload();
  await check();
  expect(
    backend.commands.filter((command) => command.method === "turn.queue"),
  ).toHaveLength(1);
});

test("cancelled pre-admission attempt shows Retry only for the exact backend witness", async ({
  page,
}) => {
  const backend = await nativeBackend(page, { extraMethods: ["turn.retry"] });
  const snapshot = backend.snapshot();
  const position = { epoch: 0, turn: 1, round: 1 };
  snapshot.messages = [
    {
      id: "cancelled-user",
      role: "user",
      text: "Interrupted request",
      parts: [],
      tool_calls: [],
      position,
    },
  ];
  snapshot.operations = [
    {
      version: 1,
      id: "cancelled-attempt",
      session_id: "s1",
      owner: "u1",
      method: "turn.submit",
      payload_hash: "fixture",
      status: "cancelled",
      revision: 1,
      created_at_ms: 10,
      updated_at_ms: 11,
      result: {
        error: {
          code: "cancelled",
          message: "Stopped by user",
          details: { cancel_reason: "user_requested" },
        },
        position,
        after_message_id: "cancelled-user",
        retry_ready: true,
      },
    },
  ];
  Object.assign(snapshot.session, {
    status: "idle",
    retry_ready: true,
    retry_operation_id: "cancelled-attempt",
  });
  await page.goto("/#session/s1");
  await expect(page.getByTestId("retry-model-request")).toHaveAttribute(
    "data-operation-id",
    "cancelled-attempt",
  );
  snapshot.session.retry_operation_id = "different-attempt";
  snapshot.session.revision++;
  backend.publish(snapshot);
  await expect(page.getByTestId("retry-model-request")).toHaveCount(0);
  snapshot.session.retry_ready = false;
  snapshot.session.retry_operation_id = "cancelled-attempt";
  snapshot.session.revision++;
  backend.publish(snapshot);
  await expect(page.getByTestId("retry-model-request")).toHaveCount(0);
  expect(
    backend.commands.filter((command) => command.method === "turn.retry"),
  ).toHaveLength(0);
});
