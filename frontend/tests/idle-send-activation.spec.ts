import { expectedPluginVariables } from "./input-inventory-expectation";
import { expect, test } from "@playwright/test";
import type { NativeInbox } from "../src/client/types";
import { nativeBackend } from "./native-fixture";
import { connectHostUI } from "./host-fixture";

const pausedInbox: NativeInbox = {
  inbox_id: "idle-send-incarnation",
  active: false,
  paused: true,
  items: [
    {
      id: 7,
      revision: 0,
      claimed: false,
      mode: "queue",
      input: { parts: [{ type: "text", text: "previously stopped input" }] },
    },
  ],
};

test("normal idle Send carries activation after Host recovery and observes the existing FIFO worker", async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const backend = await nativeBackend(page, {
    inboxTurn: async (command) => {
      await held;
      const snapshot = backend.snapshot();
      const inbox = snapshot.inbox!;
      inbox.items.push({
        id: 8,
        revision: 0,
        claimed: false,
        mode: "queue",
        input: command.params.input,
      });
      // The native owner tests execute the real dispatcher. This protocol fixture
      // publishes that owner's FIFO handoff only when the new intent is present.
      if (command.params.activate_if_idle === true) {
        inbox.paused = false;
        inbox.active = true;
        const first = inbox.items.shift()!;
        snapshot.session.status = "running";
        snapshot.messages.push({
          id: "resumed-input",
          role: "user",
          text: first.input.parts.find((part) => part.type === "text")!.text,
          parts: [],
          tool_calls: [],
        });
      }
      backend.publish(backend.snapshot());
      return {
        id: command.params.operation_id,
        session_id: "s1",
        method: command.method,
        status: "completed",
        revision: 1,
        result: { admitted: true, storage: "session_memory" },
      };
    },
  });
  backend.snapshot().inbox = structuredClone(pausedInbox);
  await page.goto("/#session/s1");
  await connectHostUI(page);
  await expect(page.getByTestId("header-host-connection")).toContainText(
    "已就绪",
  );
  await expect(page.getByTestId("inbox-resume")).toBeVisible();
  expect(backend.snapshot().inbox!.paused).toBe(true);
  expect(
    backend.commands.filter((command) => command.method === "turn.queue"),
  ).toHaveLength(0);
  const composer = page.getByTestId("composer").locator("textarea");
  await composer.fill("new explicit idle input");
  await composer.press("Enter");
  await expect
    .poll(
      () =>
        backend.commands.filter((command) => command.method === "turn.queue")
          .length,
    )
    .toBe(1);
  const sent = backend.commands.find(
    (command) => command.method === "turn.queue",
  );
  expect(sent.params).toEqual({
    operation_id: expect.any(String),
    input: {
      parts: [{ type: "text", text: "new explicit idle input" }],
      variables: expectedPluginVariables(true),
    },
    activate_if_idle: true,
  });
  await expect(composer).toHaveValue("new explicit idle input");
  release();
  await expect(composer).toHaveValue("");
  await expect(page.getByTestId("inbox-resume")).toHaveCount(0);
  await expect(page.getByTestId("queue-item")).toHaveCount(1);
  await expect(page.getByTestId("queue-item")).toContainText(
    "new explicit idle input",
  );
  await expect(page.getByTestId("queue-item")).not.toContainText(
    "previously stopped input",
  );
  await expect(
    page
      .getByTestId("chat-message")
      .filter({ hasText: "previously stopped input" }),
  ).toHaveCount(1);
  expect(
    backend.commands.filter((command) =>
      ["turn.submit", "turn.retry", "inbox.resume"].includes(command.method),
    ),
  ).toHaveLength(0);
});

test("idle Send refused by retained continuation keeps its draft and the existing paused queue", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    inboxTurn: (command) => ({
      id: command.params.operation_id,
      session_id: "s1",
      method: command.method,
      status: "failed",
      revision: 1,
      result: {
        error: {
          code: "continuation_pending",
          message:
            "Retry or recover the unfinished answer before sending new input",
        },
      },
    }),
  });
  backend.snapshot().inbox = structuredClone(pausedInbox);
  await page.goto("/#session/s1");
  await connectHostUI(page);
  const composer = page.getByTestId("composer").locator("textarea");
  await composer.fill("draft that must not enter Context");
  await composer.press("Enter");
  await expect(page.locator(".toast-body")).toContainText(
    "新消息尚未入队，草稿已保留",
  );
  await expect(composer).toHaveValue("draft that must not enter Context");
  await expect(page.getByTestId("queue-item")).toHaveCount(1);
  await expect(page.getByTestId("queue-item")).toContainText(
    "previously stopped input",
  );
  await expect(
    page
      .getByTestId("chat-message")
      .filter({ hasText: "draft that must not enter Context" }),
  ).toHaveCount(0);
  await expect(page.getByTestId("header-host-connection")).toContainText(
    "已就绪",
  );
  expect(backend.snapshot().inbox).toEqual(pausedInbox);
  const queues = backend.commands.filter(
    (command) => command.method === "turn.queue",
  );
  expect(queues).toHaveLength(1);
  expect(queues[0].params.activate_if_idle).toBe(true);
  expect(
    backend.commands.filter((command) =>
      ["turn.submit", "turn.retry", "inbox.resume", "inbox.remove"].includes(
        command.method,
      ),
    ),
  ).toHaveLength(0);
});
