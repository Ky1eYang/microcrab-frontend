import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { connectHostUI } from "./host-fixture";
import { CLIENT_TOOL_DEFINITIONS } from "../src/client/client-tools";
import type { RoundLimitRequest } from "../src/client/types";

const question = (id = "round-1"): RoundLimitRequest => ({
  request_id: id,
  parent_session_id: "s1",
  session_id: "s1",
  epoch: 1,
  turn_id: "turn-1",
  kind: "rounds",
  used: 64,
  block: 64,
  created_at_ms: 1,
});
const binding = (role: "executor" | "observer" = "executor") => ({
  role,
  lease_id: role === "executor" ? "round-lease" : undefined,
  catalog_digest: "round-digest",
  definitions: CLIENT_TOOL_DEFINITIONS,
  calls: [],
  pending: [],
});

test("round cap pauses with separate continue/stop controls and replies once on the current lease", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    clientTools: binding(),
    roundLimitRequests: [question()],
    holdRoundLimitReply: true,
  });
  await page.goto("/#session/s1");
  const card = page.getByTestId("round-limit-request");
  await expect(card).toContainText("已执行 64 轮");
  await expect(page.getByTestId("permission-request")).toHaveCount(0);
  await card.getByRole("button", { name: "继续 64 轮" }).click();
  await expect(card.getByRole("button", { name: "继续 64 轮" })).toBeDisabled();
  await expect(
    card.getByRole("button", { name: "停止", exact: true }),
  ).toBeDisabled();
  await expect
    .poll(
      () =>
        backend.commands.filter(
          (command) => command.method === "round_limit.reply",
        ).length,
    )
    .toBe(1);
  const reply = backend.commands.find(
    (command) => command.method === "round_limit.reply",
  );
  expect(reply).not.toHaveProperty("session_id");
  expect(reply.sessionId).toBe("s1");
  expect(reply.params).toEqual({
    request_id: "round-1",
    lease_id: "round-lease",
    decision: "continue",
  });
  backend.releaseRoundLimitReply();
  await expect(card).toHaveCount(0);
  backend.event("round_limit.requested", { request: question() });
  await expect(card).toHaveCount(0);
});

test("context checkpoint renders byte copy instead of round counts", async ({
  page,
}) => {
  const context: RoundLimitRequest = {
    request_id: "context-1",
    parent_session_id: "s1",
    session_id: "s1",
    epoch: 1,
    turn_id: "turn-1",
    kind: "context_bytes",
    used: 96 * 1024 * 1024,
    block: 32 * 1024 * 1024,
    created_at_ms: 1,
  };
  const backend = await nativeBackend(page, {
    clientTools: binding(),
    roundLimitRequests: [context],
    holdRoundLimitReply: true,
  });
  await page.goto("/#session/s1");
  const card = page.getByTestId("round-limit-request");
  await expect(card).toHaveAttribute("data-kind", "context_bytes");
  await expect(card).toContainText("上下文预算不足");
  await expect(card).toContainText("96.0 MiB");
  await card.getByRole("button", { name: "继续（追加 32.0 MiB）" }).click();
  await expect
    .poll(
      () =>
        backend.commands.filter(
          (command) => command.method === "round_limit.reply",
        ).length,
    )
    .toBe(1);
  const reply = backend.commands.find(
    (command) => command.method === "round_limit.reply",
  );
  expect(reply.params).toEqual({
    request_id: "context-1",
    lease_id: "round-lease",
    decision: "continue",
  });
  backend.releaseRoundLimitReply();
  await expect(card).toHaveCount(0);
});

test("round Stop renders a durable cap-stop notice after reload and later history stays after it", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    clientTools: binding(),
    roundLimitRequests: [question()],
  });
  await page.goto("/#session/s1");
  await page
    .getByTestId("round-limit-request")
    .getByRole("button", { name: "停止", exact: true })
    .click();
  await expect(page.getByTestId("round-limit-request")).toHaveCount(0);
  const receipt = {
    version: 1,
    id: "cap-stop",
    session_id: "s1",
    owner: "u1",
    method: "turn.inbox",
    payload_hash: "hash",
    status: "completed" as const,
    revision: 1,
    created_at_ms: 1,
    updated_at_ms: 2,
    result: {
      stop_reason: "round_limit",
      rounds: 64,
      after_message_id: "m2",
      position: { epoch: 1, turn: 1, round: 64 },
    },
  };
  backend.snapshot().operations.push(receipt);
  backend.event("turn", receipt);
  await expect(
    page.getByText("已按你的决定在轮次上限处停止。", { exact: true }),
  ).toBeVisible();
  backend.finish("later model answer");
  await page.reload();
  await expect(page.getByTestId("round-limit-request")).toHaveCount(0);
  const messages = page.getByTestId("chat-message");
  await expect(
    page.getByText("later model answer", { exact: true }),
  ).toBeVisible();
  const contents = await messages.allTextContents();
  const stopped = contents.findIndex((text) =>
    text.includes("已按你的决定在轮次上限处停止。"),
  );
  expect(stopped).toBeGreaterThanOrEqual(0);
  expect(
    contents.findIndex((text) => text.includes("later model answer")),
  ).toBeGreaterThan(stopped);
});

test("round observer cannot reply and settled stale requests stay gone across resync", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    clientTools: binding("observer"),
    roundLimitRequests: [question()],
  });
  await page.goto("/#session/s1");
  const card = page.getByTestId("round-limit-request");
  await expect(card.getByRole("button", { name: "继续 64 轮" })).toBeDisabled();
  await expect(card).toContainText("断线期间会话会保持暂停");
  backend.event("round_limit.settled", {
    request_id: "round-1",
    parent_session_id: "s1",
    session_id: "s1",
    decision: null,
    reason: "executor_changed",
  });
  await expect(card).toHaveCount(0);
  const reads = backend.requests.filter((request) =>
    request.path.endsWith("/round-limit/requests"),
  ).length;
  const sockets = backend.sessionSockets.length;
  backend.event("resync_required", {});
  await expect.poll(() => backend.sessionSockets.length).toBe(sockets + 1);
  expect(
    backend.requests.filter((request) =>
      request.path.endsWith("/round-limit/requests"),
    ),
  ).toHaveLength(reads);
  await expect(card).toHaveCount(0);
  backend.pendingRoundLimits.splice(0, 1, question("fresh-round"));
  backend.event("round_limit.requested", { request: question("fresh-round") });
  await expect(card).toHaveAttribute("data-request-id", "fresh-round");
  expect(
    backend.commands.filter(
      (command) => command.method === "round_limit.reply",
    ),
  ).toHaveLength(0);
});

test("large image uploads raw bytes and sends a small attachment reference", async ({
  page,
}) => {
  const backend = await nativeBackend(page, { images: true });
  await page.goto("/#session/s1");
  await connectHostUI(page);
  const composer = page.getByLabel("消息", { exact: true });
  await composer.fill("keep image caption");
  await composer.evaluate((element) => {
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCwAAAABJRU5ErkJggg==",
      ),
      (character) => character.charCodeAt(0),
    );
    const bytes = new Uint8Array(512 * 1024);
    bytes.set(png);
    const data = new DataTransfer();
    data.items.add(new File([bytes], "large.png", { type: "image/png" }));
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(page.getByTestId("composer-images").locator("img")).toHaveCount(
    1,
  );
  await page.getByTitle("发送 (Enter)").click();
  await expect
    .poll(
      () =>
        backend.commands.filter((command) => command.method === "turn.queue")
          .length,
    )
    .toBe(1);
  const upload = backend.requests.find((request) =>
    request.path.endsWith("/attachments"),
  );
  expect(upload?.method).toBe("POST");
  expect(upload?.body).toEqual({ bytes: 512 * 1024, mediaType: "image/png" });
  const command = backend.commands.find(
    (command) => command.method === "turn.queue",
  );
  expect(command.params.input.parts).toEqual([
    { type: "text", text: "keep image caption" },
    {
      type: "image",
      source: { type: "attachment", attachment_id: "attachment-1" },
    },
  ]);
  expect(Buffer.byteLength(JSON.stringify(command))).toBeLessThan(65536);
  await expect(page.getByTestId("composer-images")).toHaveCount(0);
});

test("rejected raw image upload retains draft and never sends a turn", async ({
  page,
}) => {
  const backend = await nativeBackend(page, { images: true });
  await page.route("**/api/v1/sessions/s1/attachments", (route) =>
    route.fulfill({
      status: 413,
      json: {
        error: { code: "attachment_limit", message: "Image policy rejected" },
      },
    }),
  );
  await page.goto("/#session/s1");
  await connectHostUI(page);
  const composer = page.getByLabel("消息", { exact: true });
  await composer.fill("keep rejected draft");
  await composer.evaluate((element) => {
    const bytes = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCwAAAABJRU5ErkJggg==",
      ),
      (character) => character.charCodeAt(0),
    );
    const data = new DataTransfer();
    data.items.add(new File([bytes], "small.png", { type: "image/png" }));
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(page.getByTestId("composer-images").locator("img")).toHaveCount(
    1,
  );
  await page.getByTitle("发送 (Enter)").click();
  await expect(page.locator(".toast-body")).toContainText(
    "Image policy rejected",
  );
  await expect(composer).toHaveValue("keep rejected draft");
  await expect(page.getByTestId("composer-images").locator("img")).toHaveCount(
    1,
  );
  expect(
    backend.commands.filter((command) => command.method === "turn.queue"),
  ).toHaveLength(0);
});
