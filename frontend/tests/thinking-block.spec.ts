import { expect, test } from "@playwright/test";
import { applyEvent, applySnapshot } from "../src/client/projector";
import type { NativeSnapshot, Transcript } from "../src/client/types";
import { groupBlocks } from "../src/features/conversation/groupBlocks";
import { nativeSnapshot } from "./native-fixture";

const position = { epoch: 0, turn: 1, round: 1 };
function initial(): NativeSnapshot {
  return {
    ...structuredClone(nativeSnapshot),
    session: { ...nativeSnapshot.session, status: "running" },
    operations: [],
    messages: [
      {
        id: "user",
        role: "user",
        text: "Inspect",
        parts: [],
        tool_calls: [],
        position,
      },
    ],
    history_view: {
      lineage: "selected",
      epoch: 0,
      message_count: 1,
      start_cursor: 0,
      end_cursor: 1,
      turns: [],
    },
  };
}
function observe(
  transcript: Transcript,
  round: number,
  phase: string,
  extra = {},
) {
  applyEvent(transcript, {
    v: 1,
    type: "event",
    session_id: "s1",
    subscription_id: "sub",
    generation: "g",
    sequence: round,
    event: "model_observation",
    data: {
      operation_id: "turn",
      call_id: `request-${round}`,
      ...position,
      round,
      phase,
      ...extra,
    },
  });
}
function history(
  base: NativeSnapshot,
  keepUser: boolean,
  calls = true,
): NativeSnapshot {
  return {
    ...base,
    session: { ...base.session, status: "idle" },
    messages_truncated: !keepUser,
    messages: [
      ...(keepUser ? base.messages : []),
      ...[1, 2].map((round) => ({
        id: `assistant-${round}`,
        role: "assistant" as const,
        text: "",
        parts: [],
        tool_calls: calls
          ? [{ id: `call-${round}`, name: "read", arguments: {} }]
          : [],
        position: { ...position, round },
      })),
    ],
    history_view: {
      ...base.history_view!,
      message_count: 3,
      start_cursor: keepUser ? 0 : 1,
      end_cursor: 3,
    },
  };
}

for (const text of ["Inspect the next result", " "]) {
  test(`nonempty thought survives paged canonical handoff (${JSON.stringify(text)})`, () => {
    const base = initial();
    const live = applySnapshot(base);
    for (const round of [1, 2]) {
      observe(live, round, "started");
      if (round === 2) observe(live, round, "reasoning_delta", { text });
      observe(live, round, "tool_call_delta", {
        index: 0,
        id: `call-${round}`,
        name: "read",
        arguments: "{}",
      });
      observe(live, round, "validated", { text: "" });
    }
    const thought = live.blocks.find((block) => block.kind === "reasoning")!;
    const toolIds = live.blocks
      .filter((block) => block.kind === "tool")
      .map((block) => block.id);
    const directPaged = applySnapshot(history(base, false), live);
    const admitted = applySnapshot(history(base, true), live);
    const paged = applySnapshot(history(base, false), admitted);
    const repeated = applySnapshot(history(base, false), paged);
    for (const transcript of [live, directPaged, admitted, paged, repeated]) {
      const retained = transcript.blocks.filter(
        (block) => block.kind === "reasoning",
      );
      expect(retained).toHaveLength(1);
      expect(retained[0].id).toBe(thought.id);
      expect(retained[0].payload.text).toBe(text);
      expect(
        transcript.blocks
          .filter((block) => block.kind === "tool")
          .map((block) => block.id),
      ).toEqual(toolIds);
      const items = groupBlocks(transcript.blocks);
      expect(
        items
          .filter((item) => item.type === "tools")
          .map((item) => item.blocks.map((block) => block.callId)),
      ).toEqual([["call-1"], ["call-2"]]);
    }
    expect(
      repeated.blocks.find((block) => block.kind === "reasoning")!.preview
        ?.canonicalMessageId,
    ).toBe("assistant-2");
    const replacement = history(base, false);
    replacement.history_view = {
      ...replacement.history_view!,
      lineage: "replacement",
    };
    expect(
      applySnapshot(replacement, repeated).blocks.some(
        (block) => block.kind === "reasoning",
      ),
    ).toBe(false);
  });
}

test("reasoning-only canonical messages own observed thoughts even without a rendered body", () => {
  const base = initial();
  // Legacy snapshots can lack selected-history metadata; exact positions still
  // identify an empty canonical response while its user anchor is present.
  delete base.history_view;
  const live = applySnapshot(base);
  observe(live, 2, "started");
  observe(live, 2, "reasoning_delta", { text: "Thought without final text" });
  observe(live, 2, "validated", { text: "" });
  const next = history(initial(), true, false);
  delete next.history_view;
  const admitted = applySnapshot(next, live);
  const repeated = applySnapshot(next, admitted);
  expect(
    repeated.blocks.filter((block) => block.kind === "reasoning"),
  ).toHaveLength(1);
  expect(
    repeated.blocks.find((block) => block.kind === "reasoning")!.preview
      ?.canonicalMessageId,
  ).toBe("assistant-2");
});

test("empty thoughts are omitted without removing nonempty thoughts from another invocation", () => {
  const base = initial();
  const live = applySnapshot(base);
  for (const round of [1, 2]) {
    observe(live, round, "started");
    observe(live, round, "reasoning_delta", {
      text: round === 1 ? "Keep this thought" : "",
    });
    observe(live, round, "validated", { text: "" });
  }
  const result = applySnapshot(history(base, true, false), live);
  expect(
    result.blocks
      .filter((block) => block.kind === "reasoning")
      .map((block) => [block.preview?.callId, block.payload.text]),
  ).toEqual([["request-1", "Keep this thought"]]);
});

test("reused model call IDs keep separate thoughts across exact round handoff", () => {
  const base = initial();
  const live = applySnapshot(base);
  for (const round of [1, 2]) {
    const identity = { call_id: "reused-request" };
    observe(live, round, "started", identity);
    observe(live, round, "reasoning_delta", {
      ...identity,
      text: `Thought ${round}`,
    });
    observe(live, round, "validated", { ...identity, text: "" });
  }
  const original = live.blocks.filter((block) => block.kind === "reasoning");
  const result = applySnapshot(history(base, false, false), live);
  const thoughts = result.blocks.filter((block) => block.kind === "reasoning");
  expect(thoughts.map((block) => block.id)).toEqual(
    original.map((block) => block.id),
  );
  expect(new Set(thoughts.map((block) => block.id)).size).toBe(2);
  expect(
    thoughts.map((block) => [
      block.payload.text,
      block.preview?.canonicalMessageId,
    ]),
  ).toEqual([
    ["Thought 1", "assistant-1"],
    ["Thought 2", "assistant-2"],
  ]);
});
