import { expect, test } from "@playwright/test";
import {
  applyEvent,
  applySnapshot,
  suspendPreviews,
} from "../src/client/projector";
import type { NativeSnapshot, Transcript } from "../src/client/types";
import { nativeSnapshot } from "./native-fixture";

const position = { epoch: 0, turn: 1, round: 1 };
function base(): NativeSnapshot {
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
function observe(t: Transcript, round: number, phase: string, extra = {}) {
  applyEvent(t, {
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
function assistant(id: string, round: number, text = "") {
  return {
    id,
    role: "assistant" as const,
    text,
    parts: [],
    tool_calls: [],
    position: { ...position, round },
  };
}
function page(
  messages: NativeSnapshot["messages"],
  status: "idle" | "running" = "idle",
): NativeSnapshot {
  const initial = base();
  return {
    ...initial,
    session: { ...initial.session, status },
    messages,
    history_view: {
      ...initial.history_view!,
      message_count: messages.length,
      end_cursor: messages.length,
    },
  };
}

test("idle snapshots behind an observed round preserve content until late canonical handoff", () => {
  const initial = base();
  const live = applySnapshot(initial);
  observe(live, 2, "started");
  observe(live, 2, "reasoning_delta", { text: "Thought between tools" });
  observe(live, 2, "text_delta", { text: "Explanation between tools" });
  observe(live, 2, "validated", { text: "Explanation between tools" });
  const ids = live.blocks.filter((b) => b.preview).map((b) => b.id);
  const stale = page([
    ...initial.messages,
    assistant("earlier", 1, "Earlier reply"),
  ]);
  const unchanged = JSON.stringify(live);
  let projected = applySnapshot(stale, live);
  projected = applySnapshot(stale, projected);
  expect(projected.blocks.filter((b) => b.preview).map((b) => b.id)).toEqual(
    ids,
  );
  expect(JSON.stringify(live)).toBe(unchanged);
  const admitted = page([
    ...stale.messages,
    assistant("later", 2, "Explanation between tools"),
  ]);
  projected = applySnapshot(admitted, projected);
  expect(
    projected.blocks
      .filter((b) => b.kind === "reasoning")
      .map((b) => [b.id, b.preview?.canonicalMessageId]),
  ).toEqual([[ids[0], "later"]]);
  expect(
    projected.blocks.filter(
      (b) => b.payload.text === "Explanation between tools",
    ),
  ).toHaveLength(1);
});

test("paged-out user does not erase positioned text before canonical coverage", () => {
  const live = applySnapshot(base());
  observe(live, 2, "text_delta", { text: "Retain observed suffix" });
  const observed = live.blocks.at(-1)!;
  const suffix = page([assistant("earlier", 1, "Earlier")]);
  suffix.messages_truncated = true;
  suffix.history_view = {
    ...suffix.history_view!,
    message_count: 4,
    start_cursor: 2,
    end_cursor: 3,
  };
  const result = applySnapshot(suffix, live);
  expect(result.blocks.find((b) => b.id === observed.id)?.payload.text).toBe(
    "Retain observed suffix",
  );
});

test("abbreviated canonical text cannot trim an already observed validated suffix", () => {
  const initial = base();
  let live = applySnapshot(initial);
  observe(live, 1, "text_delta", { text: "Observed full answer suffix" });
  observe(live, 1, "validated", { text: "Observed full answer suffix" });
  const bounded = page([
    ...initial.messages,
    { ...assistant("answer", 1, "Observed"), content_truncated: true },
  ]);
  live = applySnapshot(bounded, live);
  live = applySnapshot(bounded, live);
  expect(
    live.blocks
      .filter((b) => b.role === "assistant")
      .map((b) => b.payload.text),
  ).toEqual(["Observed full answer suffix"]);
  const complete = page([
    ...initial.messages,
    assistant("answer", 1, "Authoritative replacement"),
  ]);
  expect(applySnapshot(complete, live).blocks.at(-1)?.payload.text).toBe(
    "Authoritative replacement",
  );
});

test("same-round output messages hand tools off to the exact canonical call", () => {
  const initial = base();
  const live = applySnapshot(initial);
  observe(live, 1, "reasoning_delta", { text: "Plan" });
  observe(live, 1, "tool_call_delta", {
    index: 0,
    id: "call-second",
    name: "read",
    arguments: "{}",
  });
  const toolId = live.blocks.find((b) => b.kind === "tool")!.id;
  const next = page([
    ...initial.messages,
    assistant("text-output", 1, "Explanation"),
    {
      ...assistant("call-output", 1),
      tool_calls: [{ id: "call-second", name: "read", arguments: {} }],
    },
  ]);
  let result = applySnapshot(next, live);
  result = applySnapshot(next, result);
  expect(result.blocks.find((b) => b.kind === "tool")?.id).toBe(toolId);
  expect(result.blocks.find((b) => b.kind === "tool")?.messageId).toBe(
    "call-output",
  );
  expect(result.blocks.filter((b) => b.kind === "reasoning")).toHaveLength(1);
});

test("an abbreviated sibling output cannot duplicate an exact canonical tool", () => {
  const initial = base();
  const live = applySnapshot(initial);
  observe(live, 1, "tool_call_delta", {
    index: 0,
    id: "exact-call",
    name: "read",
    arguments: "{}",
  });
  const toolId = live.blocks.find((b) => b.kind === "tool")!.id;
  const next = page([
    ...initial.messages,
    { ...assistant("abbreviated-output", 1), content_truncated: true },
    {
      ...assistant("exact-output", 1),
      tool_calls: [{ id: "exact-call", name: "read", arguments: {} }],
    },
  ]);
  const result = applySnapshot(next, live);
  expect(
    result.blocks
      .filter((b) => b.kind === "tool")
      .map((b) => [b.id, b.messageId]),
  ).toEqual([[toolId, "exact-output"]]);
});

test("empty abbreviated metadata retains observed text until complete canonical admission", () => {
  const initial = base();
  const live = applySnapshot(initial);
  observe(live, 1, "text_delta", { text: "Full response" });
  const observedId = live.blocks.at(-1)!.id;
  const bounded = page([
    { ...assistant("answer", 1), content_truncated: true },
  ]);
  bounded.messages_truncated = true;
  bounded.history_view = {
    ...bounded.history_view!,
    start_cursor: 1,
    end_cursor: 2,
    message_count: 2,
  };
  let result = applySnapshot(bounded, live);
  result = applySnapshot(bounded, result);
  expect(result.blocks.map((b) => [b.id, b.payload.text])).toEqual([
    [observedId, "Full response"],
  ]);
  const admitted = page([
    ...initial.messages,
    assistant("answer", 1, "Full response"),
  ]);
  result = applySnapshot(admitted, result);
  expect(
    result.blocks.filter((b) => b.payload.text === "Full response"),
  ).toHaveLength(1);
});

test("off-page admitted thoughts keep their exact canonical message and observed position", () => {
  const initial = base();
  const live = applySnapshot(initial);
  observe(live, 1, "reasoning_delta", { text: "Thought" });
  const thoughtId = live.blocks.at(-1)!.id;
  const complete = page([
    ...initial.messages,
    assistant("owner", 1, "Answer"),
    assistant("next", 2, "Next"),
  ]);
  let result = applySnapshot(complete, live);
  const bounded = page([
    assistant("different-same-round", 1, "Other output"),
    assistant("next", 2, "Next"),
  ]);
  bounded.messages_truncated = true;
  result = applySnapshot(bounded, result);
  result = applySnapshot(bounded, result);
  expect(
    result.blocks.find((b) => b.id === thoughtId)?.preview?.canonicalMessageId,
  ).toBe("owner");
  expect(result.blocks.findIndex((b) => b.id === thoughtId)).toBeLessThan(
    result.blocks.findIndex((b) => b.messageId === "next"),
  );
  result = applySnapshot(complete, result);
  expect(
    result.blocks.find((b) => b.id === thoughtId)?.preview?.canonicalMessageId,
  ).toBe("owner");
});

test("many-round bounded tails retain earlier received content through late canonical coverage", () => {
  const initial = base();
  const live = applySnapshot(initial);
  for (let round = 1; round <= 25; round++) {
    observe(live, round, "reasoning_delta", { text: `Thought ${round}` });
    observe(live, round, "text_delta", { text: `Reply ${round}` });
    observe(live, round, "validated", { text: `Reply ${round}` });
  }
  const thoughtIds = live.blocks
    .filter((b) => b.kind === "reasoning")
    .map((b) => b.id);
  const tail = page([
    assistant("answer-24", 24, "Reply 24"),
    assistant("answer-25", 25, "Reply 25"),
  ]);
  tail.messages_truncated = true;
  tail.history_view = {
    ...tail.history_view!,
    start_cursor: 24,
    end_cursor: 26,
    message_count: 26,
  };
  let result = applySnapshot(tail, live);
  result = applySnapshot(tail, result);
  expect(
    result.blocks.filter((b) => b.kind === "text" && b.role === "assistant"),
  ).toHaveLength(25);
  expect(
    result.blocks.filter((b) => b.kind === "reasoning").map((b) => b.id),
  ).toEqual(thoughtIds);
  const full = page([
    ...initial.messages,
    ...Array.from({ length: 25 }, (_, index) =>
      assistant(`answer-${index + 1}`, index + 1, `Reply ${index + 1}`),
    ),
  ]);
  result = applySnapshot(full, result);
  result = applySnapshot(full, result);
  expect(
    result.blocks.filter((b) => b.kind === "text" && b.role === "assistant"),
  ).toHaveLength(25);
  expect(
    result.blocks.filter((b) => b.kind === "reasoning").map((b) => b.id),
  ).toEqual(thoughtIds);
});

test("conflicting abbreviated text does not borrow another observed body", () => {
  const initial = base();
  const live = applySnapshot(initial);
  observe(live, 1, "text_delta", { text: "Observed body" });
  const next = page([
    ...initial.messages,
    { ...assistant("answer", 1, "Different"), content_truncated: true },
  ]);
  expect(applySnapshot(next, live).blocks.at(-1)?.payload.text).toBe(
    "Different",
  );
});

test("complete empty assistant text settles observed text without inventing accepted content", () => {
  const initial = base();
  const live = applySnapshot(initial);
  observe(live, 1, "text_delta", { text: "Unadmitted text" });
  const result = applySnapshot(
    page([...initial.messages, assistant("empty", 1)]),
    live,
  );
  expect(result.blocks.some((b) => b.payload.text === "Unadmitted text")).toBe(
    false,
  );
});

test("wire-cloned snapshots, terminal receipts and reconnect keep unchanged streamed objects and slots", () => {
  const initial = base();
  let transcript = applySnapshot(initial);
  observe(transcript, 2, "text_delta", { text: "Retained answer" });
  observe(transcript, 2, "reasoning_delta", { text: "Retained thought" });
  observe(transcript, 2, "validated", { text: "Retained answer" });
  const blocks = [...transcript.blocks];
  const ids = blocks.map((block) => block.id);
  const assertIdentity = () => {
    expect(transcript.blocks.map((block) => block.id)).toEqual(ids);
    transcript.blocks.forEach((block, index) =>
      expect(block).toBe(blocks[index]),
    );
  };

  // A bounded snapshot has no authority over this observed later round.
  transcript = applySnapshot(structuredClone(initial), transcript);
  assertIdentity();
  applyEvent(transcript, {
    v: 1,
    type: "event",
    session_id: "s1",
    subscription_id: "sub",
    generation: "g",
    sequence: 3,
    event: "turn",
    data: {
      id: "turn",
      session_id: "s1",
      method: "turn.submit",
      status: "completed",
    },
  });
  assertIdentity();
  suspendPreviews(transcript);
  transcript = applySnapshot(structuredClone(initial), transcript);
  assertIdentity();
  expect(
    transcript.blocks
      .filter((block) => block.preview)
      .map((block) => block.payload.text),
  ).toEqual(["Retained answer", "Retained thought"]);
});

test("an unrelated streamed delta preserves sibling objects and changes only its own body", () => {
  const transcript = applySnapshot(base());
  observe(transcript, 1, "text_delta", { text: "First" });
  observe(transcript, 2, "text_delta", { text: "Second" });
  const blocks = [...transcript.blocks];
  observe(transcript, 2, "text_delta", { text: " suffix" });
  expect(transcript.blocks).toHaveLength(blocks.length);
  transcript.blocks.forEach((block, index) =>
    expect(block).toBe(blocks[index]),
  );
  expect(blocks.at(-2)?.payload.text).toBe("First");
  expect(blocks.at(-1)?.payload.text).toBe("Second suffix");
});

for (const replacement of ["lineage", "epoch"] as const) {
  test(`replacement ${replacement} fences retained observations`, () => {
    const live = applySnapshot(base());
    observe(live, 2, "reasoning_delta", { text: "Old thought" });
    observe(live, 2, "text_delta", { text: "Old text" });
    const next = base();
    next.history_view = {
      ...next.history_view!,
      [replacement]: replacement === "lineage" ? "replacement" : 1,
    };
    expect(applySnapshot(next, live).blocks.some((b) => b.preview)).toBe(false);
  });
}
