import { expect, test } from "@playwright/test";
import * as projector from "../src/client/projector";
import type { NativeSnapshot, Transcript } from "../src/client/types";
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
function observe(t: Transcript, round: number, phase: string, extra = {}) {
  projector.applyEvent(t, {
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
function complete(
  t: Transcript,
  round: number,
  thought = `Thought ${round}`,
  text = `Answer ${round}`,
) {
  observe(t, round, "started");
  observe(t, round, "reasoning_delta", { text: thought });
  observe(t, round, "text_delta", { text });
  observe(t, round, "validated", { text });
}
function suspend(t: Transcript) {
  projector.suspendPreviews(t);
}

test("resync retains validated earlier rounds and stops observed next-round thinking", () => {
  const t = projector.applySnapshot(initial());
  for (let round = 1; round <= 3; round++) complete(t, round);
  observe(t, 4, "started");
  observe(t, 4, "reasoning_delta", { text: "Incomplete future thought" });
  const known = t.blocks
    .filter((b) => b.preview && b.preview.round! <= 3)
    .map((b) => b.id);
  const unfinished = t.blocks.find(
    (b) => b.preview?.round === 4 && b.kind === "reasoning",
  )!;
  suspend(t);
  expect(t.blocks.filter((b) => b.preview).map((b) => b.id)).toEqual([
    ...known,
    unfinished.id,
  ]);
  expect(unfinished.stream).toBe("stopped");
  expect(unfinished.preview?.truncated).toBe(true);
  expect(unfinished.validated).not.toBe(true);
  expect(
    t.blocks.filter((b) => b.kind === "reasoning").map((b) => b.payload.text),
  ).toEqual([
    "Thought 1",
    "Thought 2",
    "Thought 3",
    "Incomplete future thought",
  ]);
  expect(
    t.blocks.filter((b) => b.preview).every((b) => b.stream !== "streaming"),
  ).toBe(true);
  expect(t.connected).toBe(false);
  const next = {
    ...initial(),
    messages: [
      ...initial().messages,
      ...[1, 2, 3].map((round) => ({
        id: `answer-${round}`,
        role: "assistant" as const,
        text: `Answer ${round}`,
        parts: [],
        tool_calls: [],
        position: { ...position, round },
      })),
    ],
  };
  next.history_view = {
    ...next.history_view!,
    message_count: 4,
    end_cursor: 4,
  };
  const canonical = projector.applySnapshot(next, t);
  expect(
    canonical.blocks
      .filter((b) => b.kind === "reasoning")
      .map((b) => b.payload.text),
  ).toEqual([
    "Thought 1",
    "Thought 2",
    "Thought 3",
    "Incomplete future thought",
  ]);
  expect(
    canonical.blocks
      .filter((b) => b.kind === "text" && b.role === "assistant")
      .map((b) => b.payload.text),
  ).toEqual(["Answer 1", "Answer 2", "Answer 3"]);
});

test("reasoning-only validated invocations survive a resync without inventing assistant text", () => {
  const t = projector.applySnapshot(initial());
  complete(t, 1, "Reasoning preceding tools", "");
  suspend(t);
  expect(
    t.blocks.filter((b) => b.kind === "reasoning").map((b) => b.payload.text),
  ).toEqual(["Reasoning preceding tools"]);
  expect(
    t.blocks.some(
      (b) => b.role === "assistant" && b.kind === "text" && b.payload.text,
    ),
  ).toBe(false);
});

test("resync retains exact execution-backed tool rows but rejects raw or conflicting tool evidence", () => {
  const t = projector.applySnapshot(initial());
  const tool = (call: string, extra = {}) =>
    projector.applyEvent(t, {
      v: 1,
      type: "event",
      session_id: "s1",
      subscription_id: "sub",
      generation: "g",
      sequence: 1,
      event: "tool",
      data: {
        ...position,
        operation_id: "turn",
        call_id: call,
        name: "read",
        phase: "completed",
        result: "Observed result",
        execution_id: 7,
        ...extra,
      },
    });
  tool("retained");
  const row = t.blocks.find((b) => b.callId === "retained")!;
  tool("wrong-execution");
  t.blocks.find((b) => b.callId === "wrong-execution")!.execution.call_id =
    "another-call";
  observe(t, 2, "tool_call_delta", {
    index: 0,
    id: "raw-call",
    name: "read",
    arguments: "{}",
  });
  suspend(t);
  expect(
    t.blocks
      .filter((b) => b.kind === "tool")
      .map((b) => [b.id, b.callId, b.payload.text]),
  ).toEqual([[row.id, "retained", "Observed result"]]);
});

test("resync cannot preserve validated observations from a different or unknown selected epoch", () => {
  for (const kind of [
    "other-epoch",
    "missing-position",
    "missing-history",
  ] as const) {
    const t = projector.applySnapshot(initial());
    complete(t, 1);
    if (kind === "other-epoch") t.historyView = { ...t.historyView!, epoch: 1 };
    if (kind === "missing-history") delete t.historyView;
    if (kind === "missing-position")
      for (const b of t.blocks) if (b.preview) delete b.preview.round;
    suspend(t);
    expect(
      t.blocks.filter((b) => b.preview),
      kind,
    ).toEqual([]);
  }
});

test("all thirty completed rounds survive more than 256 KiB of received content", () => {
  const t = projector.applySnapshot(initial());
  const thoughts = Array.from(
    { length: 30 },
    (_, index) => `${index + 1}:` + "x".repeat(10 * 1024),
  );
  for (const [index, thought] of thoughts.entries())
    complete(t, index + 1, thought);
  expect(
    t.blocks.filter((b) => b.kind === "reasoning").map((b) => b.payload.text),
  ).toEqual(thoughts);
  expect(
    t.blocks
      .filter((b) => b.kind === "text" && b.role === "assistant")
      .map((b) => b.payload.text),
  ).toEqual(thoughts.map((_, index) => `Answer ${index + 1}`));
});

test("all 140 completed thought and text invocations survive more than 256 rows", () => {
  const t = projector.applySnapshot(initial());
  for (let round = 1; round <= 140; round++) complete(t, round);
  expect(
    t.blocks.filter((b) => b.kind === "reasoning").map((b) => b.payload.text),
  ).toEqual(Array.from({ length: 140 }, (_, index) => `Thought ${index + 1}`));
  expect(
    t.blocks
      .filter((b) => b.kind === "text" && b.role === "assistant")
      .map((b) => b.payload.text),
  ).toEqual(Array.from({ length: 140 }, (_, index) => `Answer ${index + 1}`));
});

for (const [name, body] of [
  ["ASCII", "x".repeat(300 * 1024)],
  ["UTF-8", "你".repeat(100 * 1024)],
]) {
  test(`an individually oversized ${name} reasoning body survives alongside earlier rounds`, () => {
    const t = projector.applySnapshot(initial());
    for (let round = 1; round <= 3; round++) complete(t, round);
    observe(t, 4, "reasoning_delta", { text: body });
    expect(
      t.blocks.filter((b) => b.kind === "reasoning").map((b) => b.payload.text),
    ).toEqual(["Thought 1", "Thought 2", "Thought 3", body]);
    expect(
      t.blocks
        .filter((b) => b.kind === "text" && b.role === "assistant")
        .map((b) => b.payload.text),
    ).toEqual(["Answer 1", "Answer 2", "Answer 3"]);
  });
}

test("combined large reasoning and text bodies survive streaming and validation", () => {
  const t = projector.applySnapshot(initial());
  const thought = "r".repeat(150 * 1024);
  const text = "a".repeat(120 * 1024);
  observe(t, 1, "started");
  observe(t, 1, "reasoning_delta", { text: thought });
  observe(t, 1, "text_delta", { text });
  const bodies = () =>
    t.blocks
      .filter((b) => b.role === "assistant")
      .map((b) => [b.kind, b.payload.text]);
  expect(bodies()).toEqual([
    ["reasoning", thought],
    ["text", text],
  ]);
  observe(t, 1, "validated", { text });
  expect(bodies()).toEqual([
    ["reasoning", thought],
    ["text", text],
  ]);
  expect(
    t.blocks.filter((b) => b.preview).every((b) => b.validated === true),
  ).toBe(true);
});

test("a large pending user body and received assistant rounds remain intact", () => {
  const t = projector.applySnapshot(initial());
  t.blocks[0].temporary = true;
  t.blocks[0].payload.text = "u".repeat(300 * 1024);
  for (let round = 1; round <= 3; round++) complete(t, round);
  expect(
    t.blocks.filter((b) => b.kind === "reasoning").map((b) => b.payload.text),
  ).toEqual(["Thought 1", "Thought 2", "Thought 3"]);
  expect(t.blocks[0].payload.text).toBe("u".repeat(300 * 1024));
});

test("per-round canonical admission preserves every observed thought and replacement lineage discards them", () => {
  let snapshot = initial();
  let t = projector.applySnapshot(snapshot);
  for (let round = 1; round <= 30; round++) {
    complete(t, round, `Thought ${round}:` + "x".repeat(10 * 1024));
    snapshot = {
      ...snapshot,
      messages: [
        ...snapshot.messages,
        {
          id: `answer-${round}`,
          role: "assistant",
          text: `Answer ${round}`,
          parts: [],
          tool_calls: [],
          position: { ...position, round },
        },
      ],
      history_view: {
        ...snapshot.history_view!,
        message_count: round + 1,
        end_cursor: round + 1,
      },
    };
    t = projector.applySnapshot(snapshot, t);
  }
  expect(t.blocks.filter((b) => b.kind === "reasoning")).toHaveLength(30);
  expect(
    t.blocks.filter((b) => b.role === "assistant" && b.kind === "text"),
  ).toHaveLength(30);
  expect(t.blocks.filter((b) => b.temporary && b.role === "assistant")).toEqual(
    [],
  );
  const replacement = {
    ...snapshot,
    history_view: { ...snapshot.history_view!, lineage: "replacement" },
  };
  expect(
    projector
      .applySnapshot(replacement, t)
      .blocks.some((b) => b.kind === "reasoning"),
  ).toBe(false);
});

for (const streamed of [true, false]) {
  test(`hydrated execution bodies and observed reasoning survive the next round and resync (${streamed ? "streamed calls" : "metadata-only calls"})`, () => {
    const t = projector.applySnapshot(initial());
    complete(t, 1, "Thought prefix " + "r".repeat(40 * 1024));
    const thought = t.blocks.find((b) => b.kind === "reasoning")!;
    const id = thought.id;
    const body = thought.payload.text;
    const result = "o".repeat(115 * 1024);
    for (let index = 0; index < 2; index++) {
      const callId = `hydrated-${index}`;
      if (streamed)
        observe(t, 1, "tool_call_delta", {
          index,
          id: callId,
          name: "read",
          arguments: "{}",
        });
      projector.applyEvent(t, {
        v: 1,
        type: "event",
        session_id: "s1",
        subscription_id: "sub",
        generation: "g",
        sequence: index + 10,
        event: "tool",
        data: {
          operation_id: "turn",
          ...position,
          call_id: callId,
          execution_id: index + 1,
          name: "read",
          phase: "completed",
          preview_omitted: true,
        },
      });
      // The browser integration test exercises real executions.content paging.
      // This isolates the projector after that independent owner hydrates a row.
      t.blocks.find((b) => b.callId === callId)!.payload.text = result;
    }
    const results = () =>
      t.blocks.filter((b) => b.kind === "tool").map((b) => b.payload.text);
    observe(t, 2, "started");
    expect(t.blocks.find((b) => b.id === id)?.payload.text).toBe(body);
    expect(results()).toEqual([result, result]);
    projector.suspendPreviews(t);
    expect(t.blocks.find((b) => b.id === id)?.payload.text).toBe(body);
    expect(results()).toEqual([result, result]);
    const replacement = initial();
    replacement.history_view!.lineage = "replacement";
    expect(
      projector.applySnapshot(replacement, t).blocks.some((b) => b.preview),
    ).toBe(false);
  });
}
test("large reasoning and an admitted execution sharing its invocation key both remain intact", () => {
  const t = projector.applySnapshot(initial());
  observe(t, 1, "tool_call_delta", {
    index: 0,
    id: "shared-key-tool",
    name: "read",
    arguments: "{}",
  });
  projector.applyEvent(t, {
    v: 1,
    type: "event",
    session_id: "s1",
    subscription_id: "sub",
    generation: "g",
    sequence: 2,
    event: "tool",
    data: {
      operation_id: "turn",
      ...position,
      call_id: "shared-key-tool",
      execution_id: 1,
      name: "read",
      phase: "completed",
      preview_omitted: true,
    },
  });
  const tool = t.blocks.find((b) => b.kind === "tool")!;
  tool.payload.text = "retained execution result";
  const thought = "r".repeat(300 * 1024);
  observe(t, 1, "reasoning_delta", { text: thought });
  expect(
    t.blocks.filter((b) => b.kind === "reasoning").map((b) => b.payload.text),
  ).toEqual([thought]);
  expect(t.blocks.find((b) => b.id === tool.id)?.payload.text).toBe(
    "retained execution result",
  );
});

for (const [field, value] of [
  ["call_id", undefined],
  ["call_id", ""],
  ["execution_id", 99],
  ["call_id", "other-call"],
  ["operation_id", "other-operation"],
  ["epoch", 1],
  ["turn", 2],
  ["round", 2],
] as const) {
  test(`execution ${field}=${String(value)} survives model events but fails the resync identity fence at any body size`, () => {
    for (const body of ["Observed result", "o".repeat(300 * 1024)]) {
      const t = projector.applySnapshot(initial());
      projector.applyEvent(t, {
        v: 1,
        type: "event",
        session_id: "s1",
        subscription_id: "sub",
        generation: "g",
        sequence: 1,
        event: "tool",
        data: {
          operation_id: "turn",
          ...position,
          call_id: field === "call_id" && !value ? value : "observed-tool",
          execution_id: 1,
          name: "read",
          phase: "completed",
          preview_omitted: true,
        },
      });
      const tool = t.blocks.find((b) => b.kind === "tool")!;
      Object.assign(tool.execution!, { [field]: value });
      tool.payload.text = body;
      complete(t, 2);
      expect(t.blocks.find((b) => b.id === tool.id)?.payload.text).toBe(body);
      suspend(t);
      expect(t.blocks.some((b) => b.id === tool.id)).toBe(false);
      expect(
        t.blocks
          .filter((b) => b.kind === "reasoning")
          .map((b) => b.payload.text),
      ).toEqual(["Thought 2"]);
    }
  });
}

test("interrupted reasoning stays partial through late validation and canonical text admission", () => {
  const base = initial();
  const t = projector.applySnapshot(base);
  observe(t, 1, "started");
  observe(t, 1, "reasoning_delta", { text: "Known prefix" });
  const thought = t.blocks.find((b) => b.kind === "reasoning")!;
  const text = t.blocks.find((b) => b.kind === "text" && b.preview)!;
  expect(thought.preview).toBe(text.preview);
  suspend(t);
  expect(thought.preview?.truncated).toBe(true);
  expect(text.preview?.truncated).not.toBe(true);
  expect(thought.temporary).toBe(true);
  expect(thought.validated).not.toBe(true);
  observe(t, 1, "reasoning_delta", { text: " and known suffix" });
  observe(t, 1, "validated", { text: "Canonical assistant body" });
  expect(thought.payload.text).toBe("Known prefix and known suffix");
  expect(thought.stream).toBe("stopped");
  expect(thought.validated).toBe(true);
  const admitted: NativeSnapshot = {
    ...base,
    messages: [
      ...base.messages,
      {
        id: "admitted",
        role: "assistant",
        text: "Canonical assistant body",
        parts: [],
        tool_calls: [],
        position,
      },
    ],
    history_view: { ...base.history_view!, end_cursor: 2, message_count: 2 },
  };
  const canonical = projector.applySnapshot(admitted, t);
  const retained = canonical.blocks.find((b) => b.kind === "reasoning")!;
  expect(retained.id).toBe(thought.id);
  expect(retained.preview?.canonicalMessageId).toBe("admitted");
  expect(retained.preview?.truncated).toBe(true);
  expect(retained.stream).toBe("stopped");
  expect(retained.temporary).toBe(false);
  expect(
    projector
      .applySnapshot(
        {
          ...admitted,
          history_view: { ...admitted.history_view!, lineage: "replacement" },
        },
        canonical,
      )
      .blocks.some((b) => b.kind === "reasoning"),
  ).toBe(false);
});
