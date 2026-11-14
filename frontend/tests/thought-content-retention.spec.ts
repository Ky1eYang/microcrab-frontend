import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

const tail = "RETAINED_THOUGHT_END";
for (const scenario of [
  {
    name: "single ASCII thought above 256 KiB",
    thought: "r".repeat(300 * 1024) + tail,
    text: "Small final answer",
  },
  {
    name: "single UTF-8 thought above 256 KiB",
    thought: "你".repeat(100 * 1024) + tail,
    text: "Small final answer",
  },
  {
    name: "combined thought and validated text above 256 KiB",
    thought: "r".repeat(150 * 1024) + tail,
    text: "a".repeat(120 * 1024) + "FINAL_ANSWER_END",
  },
]) {
  test(`${scenario.name} stays visible and reopenable through completion`, async ({
    page,
  }) => {
    const backend = await nativeBackend(page);
    const snapshot = backend.snapshot();
    snapshot.session.status = "running";
    snapshot.messages[0].position = { epoch: 0, turn: 1, round: 0 };
    snapshot.messages[1].position = { epoch: 0, turn: 1, round: 1 };
    snapshot.history_view = {
      lineage: "received-thought-content",
      epoch: 0,
      start_cursor: 0,
      end_cursor: snapshot.messages.length,
      message_count: snapshot.messages.length,
      turns: [],
    };
    await page.goto("/#session/s1");
    await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
    const identity = {
      operation_id: "received-thought-operation",
      call_id: "received-thought-call",
      epoch: 0,
      turn: 1,
      round: 2,
    };
    backend.event("model_observation", { ...identity, phase: "started" });
    backend.event("model_observation", {
      ...identity,
      phase: "reasoning_delta",
      text: scenario.thought,
    });
    const thought = page.getByTestId("think-block");
    await expect(thought).toHaveCount(1);
    await expect(thought).toHaveAttribute("data-streaming", "true");
    await expect(thought).toContainText(tail);
    backend.event("model_observation", {
      ...identity,
      phase: "validated",
      text: scenario.text,
    });
    await expect(thought).toHaveCount(1);
    await expect(thought).toHaveAttribute("data-streaming", "false");
    await expect(thought).toHaveAttribute("data-expanded", "false");
    await thought.getByRole("button").click();
    await expect(thought).toContainText(tail);
    const content = thought.locator(".think-content");
    expect((await content.textContent())?.length).toBe(scenario.thought.length);
    backend.event("model_observation", {
      ...identity,
      call_id: "next-thought-call",
      round: 3,
      phase: "started",
    });
    backend.event("model_observation", {
      ...identity,
      call_id: "next-thought-call",
      round: 3,
      phase: "text_delta",
      text: "Next request acknowledged",
    });
    await expect(
      page.getByText("Next request acknowledged", { exact: true }),
    ).toBeVisible();
    await expect(thought).toContainText(tail);
    expect((await content.textContent())?.length).toBe(scenario.thought.length);
    // A content-size policy must not fabricate a subscription gap or refresh.
    expect(backend.sessionSockets).toHaveLength(1);
  });
}
