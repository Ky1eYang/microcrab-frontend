import { expect, test, type Page } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import zh from "../src/i18n/locales/zh-CN.json" with { type: "json" };

const identity = {
  operation_id: "thought-transition",
  call_id: "thought-call",
  epoch: 0,
  turn: 1,
  round: 2,
};
const body =
  "Previously visible reasoning must remain available after this model call finishes.";
async function thinking(page: Page) {
  const backend = await nativeBackend(page);
  const snapshot = backend.snapshot();
  snapshot.session.status = "running";
  snapshot.messages[0].position = { epoch: 0, turn: 1, round: 0 };
  snapshot.messages[1].position = { epoch: 0, turn: 1, round: 1 };
  snapshot.history_view = {
    lineage: "thought-transition-lineage",
    epoch: 0,
    start_cursor: 0,
    end_cursor: 2,
    message_count: 2,
    turns: [
      {
        epoch: 0,
        turn: 1,
        tool_calls: 0,
        ordinary_tool_calls: 0,
        delegate_calls: 0,
      },
    ],
  };
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  backend.event("model_observation", { ...identity, phase: "started" });
  backend.event("model_observation", {
    ...identity,
    phase: "reasoning_delta",
    text: body,
  });
  const thought = page.getByTestId("think-block");
  await expect(thought).toHaveAttribute("data-streaming", "true");
  await expect(thought).toHaveAttribute("data-expanded", "true");
  await expect(thought.getByText(body, { exact: true })).toBeVisible();
  return { backend, thought };
}

test("THINKING becomes a retained collapsed THOUGHT through response validation and subsequent tools", async ({
  page,
}) => {
  const { backend, thought } = await thinking(page);
  backend.event("model_observation", {
    ...identity,
    phase: "validated",
    text: "Inspecting the next file",
  });
  await expect(thought).toHaveAttribute("data-streaming", "false");
  await expect(thought).toHaveAttribute("data-expanded", "false");
  await expect(
    thought.getByText(zh["think.done"], { exact: true }),
  ).toBeVisible();
  const snapshot = structuredClone(backend.snapshot());
  snapshot.messages.push({
    id: "thought-response",
    role: "assistant",
    text: "Inspecting the next file",
    parts: [],
    position: { epoch: 0, turn: 1, round: 2 },
    tool_calls: [{ id: "thought-tool", name: "read", arguments: {} }],
  });
  snapshot.history_view!.end_cursor = snapshot.messages.length;
  snapshot.history_view!.message_count = snapshot.messages.length;
  backend.publish(snapshot);
  backend.event("tool", {
    operation_id: identity.operation_id,
    epoch: 0,
    turn: 1,
    round: 2,
    execution_id: 3,
    call_id: "thought-tool",
    name: "read",
    phase: "completed",
    result: "Next file content",
  });
  await expect(page.getByTestId("tool-row")).toHaveCount(1);
  await expect(thought).toHaveCount(1);
  await expect(thought).toHaveAttribute("data-expanded", "false");
  await thought.getByRole("button").click();
  await expect(thought.getByText(body, { exact: true })).toBeVisible();
  backend.event("model_observation", {
    ...identity,
    call_id: "next-thought-call",
    round: 3,
    phase: "started",
  });
  await expect(thought).toHaveAttribute("data-expanded", "true");
});

test("a validated collapsed THOUGHT survives real disconnect and same-history reconnect before canonical admission", async ({
  page,
}) => {
  const { backend, thought } = await thinking(page);
  backend.event("model_observation", {
    ...identity,
    phase: "validated",
    text: "Provider response",
  });
  await expect(thought).toHaveAttribute("data-expanded", "false");
  backend.sockets
    .at(-1)!
    .close({ code: 1012, reason: "between validation and admission" });
  await expect.poll(() => backend.sockets.length).toBe(2);
  // The reconnect opens a second session socket.
  await expect.poll(() => backend.sessionSockets.length).toBe(2);
  await expect(thought).toHaveCount(1);
  await expect(thought).toHaveAttribute("data-streaming", "false");
  await expect(thought).toHaveAttribute("data-expanded", "false");
  await expect(
    thought.locator("..").getByTestId("incomplete-output"),
  ).toHaveCount(0);
  await thought.getByRole("button").click();
  await expect(thought.getByText(body, { exact: true })).toBeVisible();
});

for (const trigger of ["resync", "gap", "disconnect"] as const) {
  test(`active THINKING survives ${trigger} as an incomplete collapsed THOUGHT before validation`, async ({
    page,
  }) => {
    const { backend, thought } = await thinking(page);
    if (trigger === "disconnect")
      backend.sockets
        .at(-1)!
        .close({ code: 1012, reason: "observation interrupted" });
    else {
      // Hold the replacement so the assertion observes the suspension itself.
      backend.holdNextSubscription();
      if (trigger === "gap")
        backend.event(
          "model_observation",
          {
            ...identity,
            phase: "validated",
            text: "A response whose validation was missed",
          },
          2,
        );
      else backend.event("resync_required", {});
      await expect.poll(() => backend.pendingSubscriptions.length).toBe(1);
      await expect.poll(() => backend.sessionSockets.length).toBe(2);
    }
    await expect(thought).toHaveCount(1);
    await expect(thought).toHaveAttribute("data-streaming", "false");
    await expect(thought).toHaveAttribute("data-expanded", "false");
    await expect(
      thought.getByText(zh["think.done"], { exact: true }),
    ).toBeVisible();
    await expect(
      thought.locator("..").getByTestId("incomplete-output"),
    ).toBeVisible();
    await thought.getByRole("button").click();
    await expect(thought.getByText(body, { exact: true })).toBeVisible();
    if (trigger === "disconnect") {
      await expect.poll(() => backend.sockets.length).toBe(2);
      // The reconnect opens a second session socket.
      await expect.poll(() => backend.sessionSockets.length).toBe(2);
      backend.event("model_observation", {
        ...identity,
        phase: "validated",
        text: "Recovered assistant response",
      });
    } else {
      const replacement = structuredClone(backend.snapshot());
      replacement.messages.push({
        id: "recovered-thought-response",
        role: "assistant",
        text: "Recovered assistant response",
        parts: [],
        position: { epoch: 0, turn: 1, round: 2 },
        tool_calls: [
          { id: "recovered-thought-tool", name: "read", arguments: {} },
        ],
      });
      replacement.history_view!.message_count = replacement.messages.length;
      replacement.history_view!.end_cursor = replacement.messages.length;
      backend.releaseSubscription(0, replacement, {
        subscription_id: "recovered-thought",
        generation: "recovered-thought-generation",
        sequence: 0,
      });
      await expect(
        page.getByText("Recovered assistant response", { exact: true }),
      ).toBeVisible();
      backend.event("model_observation", {
        ...identity,
        phase: "validated",
        text: "Recovered assistant response",
      });
      await expect(page.getByTestId("tool-row")).toHaveCount(1);
    }
    await expect(thought.getByText(body, { exact: true })).toBeVisible();
    await expect(thought).toHaveAttribute("data-streaming", "false");
    await expect(
      thought.locator("..").getByTestId("incomplete-output"),
    ).toBeVisible();
  });
}
