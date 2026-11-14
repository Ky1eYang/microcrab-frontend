import { expect, test } from "@playwright/test";
import {
  applyEvent,
  applySnapshot,
  createBlock,
} from "../src/client/projector";
import type { NativeOperation, NativeSnapshot } from "../src/client/types";
import { nativeBackend, nativeSnapshot } from "./native-fixture";

const position = (turn: number) => ({ epoch: 0, turn, round: 1 });
const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
  turn: number,
) => ({ id, role, text, parts: [], tool_calls: [], position: position(turn) });
const failure: NativeOperation = {
  version: 1,
  id: "failed-turn",
  session_id: "s1",
  owner: "owner",
  method: "turn.submit",
  payload_hash: "hash",
  status: "failed",
  revision: 1,
  created_at_ms: 100,
  updated_at_ms: 200,
  result: { error: { message: "provider failure" }, position: position(1) },
};
const initial: NativeSnapshot = {
  ...nativeSnapshot,
  messages: [message("u1", "user", "First prompt", 1)],
  operations: [failure],
};
const continued: NativeSnapshot = {
  ...initial,
  messages: [
    ...initial.messages,
    message("u2", "user", "Next prompt", 2),
    message("a2", "assistant", "Next answer", 2),
  ],
};
for (const touch of [false, true]) {
  test.describe(`trajectory Markdown actions (touch=${touch})`, () => {
    test.use({ hasTouch: touch });
    test("copy and expand share visibility, size, and keyboard access", async ({
      page,
    }) => {
      await nativeBackend(page);
      await page.goto("/#session/s1");
      await page.getByRole("tab", { name: "轨迹", exact: true }).click();
      await page
        .locator('[data-testid="trajectory-entry"][data-kind="message"]')
        .click();
      await page.getByRole("tab", { name: "预览", exact: true }).click();
      const content = page
        .getByTestId("trajectory-inspector")
        .locator(".trajectory-content");
      const actions = content.locator(".trajectory-content-action");
      await expect(actions).toHaveCount(2);
      await page.mouse.move(1, 1);
      for (const action of await actions.all())
        await expect(action).toHaveCSS("opacity", touch ? "1" : "0");
      if (!touch) {
        await content.hover();
        for (const action of await actions.all())
          await expect(action).toHaveCSS("opacity", "1");
        await page.mouse.move(1, 1);
        await content.locator(".trajectory-content-body").focus();
        for (const action of await actions.all())
          await expect(action).toHaveCSS("opacity", "1");
        await page.keyboard.press("Shift+Tab");
        await expect(actions.nth(1)).toBeFocused();
        await expect(actions.nth(1)).toHaveCSS("outline-width", "2px");
      }
      const sizes = await actions.evaluateAll((buttons) =>
        buttons.map((button) => {
          const style = getComputedStyle(button);
          return [style.width, style.height, style.color, style.borderRadius];
        }),
      );
      expect(sizes[0]).toEqual(sizes[1]);
      await actions.nth(1).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(actions.nth(1)).toBeFocused();
    });
  });
}

test("canonical assistant text and calls retain their observed appearance order", () => {
  let transcript = applySnapshot({ ...initial, operations: [] });
  const observe = (phase: string, extra: Record<string, unknown> = {}) =>
    applyEvent(transcript, {
      v: 1,
      type: "event",
      subscription_id: "sub",
      generation: "g",
      sequence: 1,
      session_id: "s1",
      event: "model_observation",
      data: {
        operation_id: "observed",
        call_id: "provider",
        ...position(1),
        phase,
        ...extra,
      },
    });
  observe("started");
  observe("tool_call_delta", {
    index: 0,
    id: "read",
    name: "read",
    arguments: "{}",
  });
  observe("text_delta", { text: "After the tool" });
  expect(transcript.blocks.map((block) => block.kind)).toEqual([
    "text",
    "tool",
    "text",
  ]);
  const canonical = {
    ...initial,
    operations: [],
    messages: [
      ...initial.messages,
      {
        ...message("a1", "assistant", "After the tool", 1),
        tool_calls: [{ id: "read", name: "read", arguments: {} }],
      },
    ],
  };
  transcript = applySnapshot(canonical, transcript);
  transcript = applySnapshot(canonical, transcript);
  expect(transcript.blocks.map((block) => block.kind)).toEqual([
    "text",
    "tool",
    "text",
  ]);
});

const identities = (snapshot: ReturnType<typeof applySnapshot>) =>
  snapshot.blocks.map((block) => block.messageId);

test("failed feedback keeps its position across a later turn, repeated snapshots, and reload", () => {
  let transcript = applySnapshot(initial);
  expect(identities(transcript)).toEqual(["u1", "error-failed-turn"]);
  transcript = applySnapshot(continued, transcript);
  transcript = applySnapshot(continued, transcript);
  expect(identities(transcript)).toEqual([
    "u1",
    "error-failed-turn",
    "u2",
    "a2",
  ]);
  expect(identities(applySnapshot(continued))).toEqual(identities(transcript));
  const feedback = transcript.blocks.find((block) => block.stream === "error")!;
  expect(feedback.operationId).toBe(failure.id);
  expect(feedback.startedMs).toBeUndefined();
  expect(feedback.endedMs).toBeUndefined();
});

test("legacy live feedback survives optimistic user replacement without moving under the new reply", () => {
  const legacy = { ...failure, result: { error: { message: "legacy" } } };
  let transcript = applySnapshot({ ...initial, operations: [] });
  const feedback = createBlock("s1", "error-failed-turn", "text");
  feedback.stream = "error";
  feedback.payload.text = "Observed failure";
  transcript.blocks.push(feedback);
  const pending = createBlock("s1", "optimistic-user", "text", "text", "user");
  pending.temporary = true;
  pending.operationId = "next-submission";
  pending.payload.text = "Next prompt";
  transcript.blocks.push(pending);
  const before = structuredClone(transcript);
  transcript = applySnapshot(
    {
      ...continued,
      operations: [legacy],
      messages: continued.messages.map((message) =>
        message.id === "u2"
          ? { ...message, submission_operation_id: "next-submission" }
          : message,
      ),
    },
    transcript,
  );
  expect(identities(transcript)).toEqual([
    "u1",
    "error-failed-turn",
    "u2",
    "a2",
  ]);
  expect(
    transcript.blocks.filter((block) => block.stream === "error"),
  ).toHaveLength(1);
  expect(before.blocks[1]).toEqual(feedback);
  // No old receipt claims a canonical turn association it did not record.
  expect(transcript.blocks[1].position).toBeUndefined();
});

test("live text and reasoning retain their first visible appearance order through canonical replacement", () => {
  for (const phases of [
    ["text_delta", "reasoning_delta"],
    ["reasoning_delta", "text_delta"],
  ]) {
    let transcript = applySnapshot({ ...initial, operations: [] });
    const observe = (phase: string) =>
      applyEvent(transcript, {
        v: 1,
        type: "event",
        subscription_id: "sub",
        generation: "g",
        sequence: 1,
        session_id: "s1",
        event: "model_observation",
        data: {
          operation_id: "observed",
          call_id: "provider",
          ...position(1),
          phase,
          text: phase === "text_delta" ? "Answer" : "Thinking",
        },
      });
    observe("started");
    phases.forEach(observe);
    const expected = [
      "First prompt",
      ...phases.map((phase) =>
        phase === "text_delta" ? "Answer" : "Thinking",
      ),
    ];
    expect(transcript.blocks.map((block) => block.payload.text)).toEqual(
      expected,
    );
    transcript = applySnapshot(
      {
        ...initial,
        operations: [],
        messages: [
          ...initial.messages,
          message("a1", "assistant", "Answer", 1),
        ],
      },
      transcript,
    );
    expect(transcript.blocks.map((block) => block.payload.text)).toEqual(
      expected,
    );
  }
});

test("same-round retries retain each durable failure before successful output on reload", () => {
  const first = {
    ...failure,
    result: { ...(failure.result as object), after_message_id: "u1" },
  };
  const retry = {
    ...first,
    id: "failed-retry",
    method: "turn.retry",
    updated_at_ms: 300,
  };
  const snapshot = {
    ...initial,
    // Receipt list order is not conversation order.
    operations: [retry, first],
    messages: [
      ...initial.messages,
      message("a1", "assistant", "Retry answer", 1),
      ...continued.messages.slice(1),
    ],
  };
  const expected = [
    "u1",
    "error-failed-turn",
    "error-failed-retry",
    "a1",
    "u2",
    "a2",
  ];
  let transcript = applySnapshot({ ...initial, operations: [first, retry] });
  transcript = applySnapshot(snapshot, transcript);
  transcript = applySnapshot(snapshot, transcript);
  expect(identities(transcript)).toEqual(expected);
  expect(identities(applySnapshot(snapshot))).toEqual(expected);
});

test("durable boundaries override an incorrectly retained end-of-turn failure", () => {
  const snapshot = {
    ...continued,
    operations: [
      {
        ...failure,
        result: { ...(failure.result as object), after_message_id: "u1" },
      },
    ],
  };
  const prior = applySnapshot({ ...snapshot, operations: [] });
  const feedback = createBlock("s1", "error-failed-turn", "text");
  feedback.stream = "error";
  prior.blocks.push(feedback);
  const before = structuredClone(prior);
  expect(identities(applySnapshot(snapshot, prior))).toEqual([
    "u1",
    "error-failed-turn",
    "u2",
    "a2",
  ]);
  expect(prior).toEqual(before);
});

test("a failed later round follows all parts of its last durable message", () => {
  const snapshot = {
    ...continued,
    messages: [
      message("u1", "user", "First prompt", 1),
      {
        ...message("a1", "assistant", "Tool introduction", 1),
        tool_calls: [{ id: "read", name: "read", arguments: {} }],
      },
      {
        ...message("a-retry", "assistant", "Recovered", 1),
        position: { ...position(1), round: 2 },
      },
      ...continued.messages.slice(1),
    ],
    operations: [
      {
        ...failure,
        result: {
          error: { message: "round two failed" },
          position: { ...position(1), round: 2 },
          after_message_id: "a1",
        },
      },
    ],
  };
  expect(identities(applySnapshot(snapshot))).toEqual([
    "u1",
    "a1",
    "a1",
    "error-failed-turn",
    "a-retry",
    "u2",
    "a2",
  ]);
});

test("legacy position fallback respects round boundaries and then preserves observation", () => {
  const snapshot = {
    ...initial,
    messages: [
      ...initial.messages,
      {
        ...message("a2", "assistant", "Later round", 1),
        position: { ...position(1), round: 2 },
      },
    ],
  };
  let transcript = applySnapshot(snapshot);
  expect(identities(transcript)).toEqual(["u1", "error-failed-turn", "a2"]);
  transcript = applySnapshot(snapshot, transcript);
  expect(identities(transcript)).toEqual(["u1", "error-failed-turn", "a2"]);
});

test("failed reasoning is not rebound to same-round retry output", () => {
  let transcript = applySnapshot({ ...initial, operations: [] });
  applyEvent(transcript, {
    v: 1,
    type: "event",
    subscription_id: "sub",
    generation: "g",
    sequence: 1,
    session_id: "s1",
    event: "model_observation",
    data: {
      operation_id: failure.id,
      call_id: "failed-provider",
      ...position(1),
      phase: "reasoning_delta",
      text: "Failed attempt thinking",
    },
  });
  const snapshot = {
    ...initial,
    operations: [
      {
        ...failure,
        result: { ...(failure.result as object), after_message_id: "u1" },
      },
    ],
    messages: [
      ...initial.messages,
      message("a-retry", "assistant", "Retry answer", 1),
    ],
  };
  transcript = applySnapshot(snapshot, transcript);
  transcript = applySnapshot(snapshot, transcript);
  expect(transcript.blocks.map((block) => block.payload.text)).toEqual([
    "First prompt",
    "Failed attempt thinking",
    expect.stringContaining("请求未能成功响应"),
    "Retry answer",
  ]);
  const reasoning = transcript.blocks[1];
  expect(reasoning.preview?.canonicalMessageId).toBeUndefined();
  expect(reasoning.messageId).not.toBe("a-retry");
});

test("orphaned historical feedback never falls through below replacement output", () => {
  const prior = applySnapshot(initial);
  const replacement = {
    ...continued,
    messages: continued.messages.slice(1),
    operations: [],
  };
  expect(identities(applySnapshot(replacement, prior))).toEqual([
    "error-failed-turn",
    "u2",
    "a2",
  ]);
});

test("undo removes suffix failure feedback while preserving earlier selected failures", () => {
  const earlier = {
    ...failure,
    result: { ...(failure.result as object), after_message_id: "u1" },
  };
  const suffix = {
    ...failure,
    id: "suffix-failure",
    updated_at_ms: 300,
    result: {
      error: { message: "Later failure" },
      position: position(2),
      after_message_id: "u2",
    },
  };
  const prior = applySnapshot({
    ...continued,
    messages: continued.messages.slice(0, 2),
    operations: [earlier, suffix],
  });
  expect(identities(prior)).toEqual([
    "u1",
    "error-failed-turn",
    "u2",
    "error-suffix-failure",
  ]);
  const restored = {
    ...initial,
    operations: [earlier],
    restored_input: {
      message_id: "u2",
      parts: [{ type: "text" as const, text: "Next prompt" }],
    },
  };
  const expected = ["u1", "error-failed-turn"];
  const transcript = applySnapshot(restored, prior);
  expect(identities(transcript)).toEqual(expected);
  expect(identities(applySnapshot(restored, transcript))).toEqual(expected);
  expect(identities(applySnapshot(restored))).toEqual(expected);
});

test("conversation displays error then a new turn in appearance order after refresh and reload", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  Object.assign(backend.snapshot(), structuredClone(initial));
  await page.goto("/#session/s1");
  const transcript = page.locator(".transcript-inner");
  await expect(
    transcript.getByText("请求未能成功响应", { exact: true }),
  ).toHaveCount(1);
  Object.assign(backend.snapshot(), structuredClone(continued));
  backend.publish(backend.snapshot());
  const checkOrder = async () => {
    await expect(
      transcript.getByText("Next answer", { exact: true }),
    ).toBeVisible();
    await expect(
      transcript.getByText("请求未能成功响应", { exact: true }),
    ).toHaveCount(1);
    const text = await transcript.innerText();
    expect(text.indexOf("First prompt")).toBeLessThan(
      text.indexOf("请求未能成功响应"),
    );
    expect(text.indexOf("请求未能成功响应")).toBeLessThan(
      text.indexOf("Next prompt"),
    );
    expect(text.indexOf("Next prompt")).toBeLessThan(
      text.indexOf("Next answer"),
    );
  };
  await checkOrder();
  backend.publish(backend.snapshot());
  await checkOrder();
  await page.reload();
  await checkOrder();
});
