import { expect, test } from "@playwright/test";
import { applyEvent, applySnapshot } from "../src/client/projector";
import { nativeSnapshot } from "./native-fixture";
import type { NativeEvent, NativeSnapshot } from "../src/client/types";

const position = { epoch: 0, turn: 1, round: 1 };
function selected(lineage = "selected"): NativeSnapshot {
  return {
    ...structuredClone(nativeSnapshot),
    session: { ...nativeSnapshot.session, status: "running" },
    messages: [
      {
        id: "user-1",
        role: "user",
        text: "run tools",
        parts: [],
        tool_calls: [],
        position,
      },
    ],
    operations: [],
    inbox: { items: [], active: true, paused: false },
    history_view: {
      lineage,
      epoch: 0,
      message_count: 1,
      start_cursor: 0,
      end_cursor: 1,
      turns: [
        {
          epoch: 0,
          turn: 1,
          ordinary_tool_calls: 0,
          delegate_calls: 0,
          tool_calls: 0,
        },
      ],
    },
  };
}
function tool(id: string, sequence = 1): NativeEvent {
  return {
    v: 1,
    type: "event",
    session_id: "s1",
    subscription_id: "sub",
    generation: "g",
    sequence,
    event: "tool",
    data: {
      ...position,
      operation_id: "op-1",
      call_id: id,
      name: "read",
      phase: "started",
      execution_id: sequence,
      arguments: { path: id },
    },
  };
}
function canonical(
  base: NativeSnapshot,
  omitted: boolean,
  keepUser = true,
): NativeSnapshot {
  const assistant = {
    id: "assistant-1",
    role: "assistant" as const,
    text: "",
    parts: [],
    position,
    tool_calls: omitted
      ? []
      : [{ id: "tool-a", name: "read", arguments: { path: "tool-a" } }],
    ...(omitted ? { content_truncated: true } : {}),
  };
  return {
    ...base,
    messages: [...(keepUser ? base.messages : []), assistant],
    messages_truncated: !keepUser,
    history_view: {
      ...base.history_view!,
      message_count: 2,
      start_cursor: keepUser ? 0 : 1,
      end_cursor: 2,
      turns: [
        {
          epoch: 0,
          turn: 1,
          ordinary_tool_calls: 1,
          delegate_calls: 0,
          tool_calls: 1,
        },
      ],
    },
  };
}

test("abbreviated canonical messages retain observed tools until exact handoff and keep the same row thereafter", () => {
  const base = selected();
  const live = applySnapshot(base);
  applyEvent(live, tool("tool-a"));
  const original = live.blocks.find((block) => block.kind === "tool")!;
  const idle = canonical(base, true);
  idle.session = { ...idle.session, status: "idle" };
  const idleBounded = applySnapshot(idle, live);
  expect(
    idleBounded.blocks.filter((block) => block.kind === "tool"),
  ).toHaveLength(1);
  expect(idleBounded.blocks.find((block) => block.kind === "tool")!.id).toBe(
    original.id,
  );
  const bounded = applySnapshot(canonical(base, true), live);
  expect(bounded.blocks.filter((block) => block.kind === "tool")).toHaveLength(
    1,
  );
  expect(bounded.blocks.find((block) => block.kind === "tool")!.id).toBe(
    original.id,
  );
  const withResult = canonical(base, false);
  withResult.messages.push({
    id: "result-1",
    role: "tool",
    text: "canonical result",
    parts: [],
    tool_calls: [],
    call_id: "tool-a",
    tool_name: "read",
    position,
  });
  withResult.history_view = {
    ...withResult.history_view!,
    message_count: 3,
    end_cursor: 3,
  };
  const admitted = applySnapshot(withResult, bounded);
  expect(admitted.blocks.filter((block) => block.kind === "tool")).toHaveLength(
    1,
  );
  expect(
    admitted.blocks.find((block) => block.kind === "tool")!.payload.text,
  ).toBe("canonical result");
  const row = admitted.blocks.find((block) => block.kind === "tool")!;
  expect(row.id).toBe(original.id);
  expect(row.messageId).toBe("assistant-1");
  expect(row.temporary).not.toBe(true);
  const repeated = applySnapshot(canonical(base, false), admitted);
  expect(repeated.blocks.find((block) => block.kind === "tool")!.id).toBe(
    original.id,
  );
  applyEvent(repeated, {
    ...tool("tool-a"),
    data: {
      ...(tool("tool-a").data as object),
      phase: "completed",
      result: "done",
    },
  });
  expect(repeated.blocks.filter((block) => block.kind === "tool")).toHaveLength(
    1,
  );
  expect(repeated.blocks.find((block) => block.kind === "tool")!.id).toBe(
    original.id,
  );
});

test("paged-out user anchors do not erase exact selected-lineage tools and branch replacement cannot inherit their identity", () => {
  const base = selected();
  const live = applySnapshot(base);
  applyEvent(live, tool("tool-a"));
  const originalId = live.blocks.find((block) => block.kind === "tool")!.id;
  const bounded = applySnapshot(canonical(base, true, false), live);
  expect(bounded.blocks.find((block) => block.kind === "tool")!.id).toBe(
    originalId,
  );
  const admitted = applySnapshot(canonical(base, false, false), bounded);
  expect(admitted.blocks.filter((block) => block.kind === "tool")).toHaveLength(
    1,
  );
  expect(admitted.blocks.find((block) => block.kind === "tool")!.id).toBe(
    originalId,
  );
  const replacement = applySnapshot(
    canonical(selected("other-branch"), false),
    admitted,
  );
  expect(
    replacement.blocks.find((block) => block.kind === "tool")!.id,
  ).not.toBe(originalId);
  expect(
    replacement.blocks.find((block) => block.kind === "tool")!.executionId,
  ).toBeUndefined();
});

test("unpositioned repeated calls cannot inherit a live identity from lineage alone", () => {
  const base = selected();
  const live = applySnapshot(base);
  const unpositioned = tool("tool-a");
  unpositioned.data = {
    operation_id: "unpositioned",
    call_id: "tool-a",
    name: "read",
    phase: "started",
    execution_id: 23,
  };
  applyEvent(live, unpositioned);
  const preview = live.blocks.find((block) => block.kind === "tool")!;
  const next = canonical(base, false, false);
  next.messages = next.messages.map((message) => ({
    ...message,
    position: null,
  }));
  const result = applySnapshot(next, live);
  const row = result.blocks.find((block) => block.messageId === "assistant-1")!;
  expect(row.id).not.toBe(preview.id);
  expect(row.executionId).toBeUndefined();
});

test("unanchored exact tools remain after earlier recorded rounds", () => {
  const base = selected();
  base.messages = [];
  base.history_view = {
    ...base.history_view!,
    message_count: 0,
    end_cursor: 0,
  };
  const live = applySnapshot(base);
  const later = tool("later-tool");
  later.data = { ...(later.data as object), round: 3 };
  applyEvent(live, later);
  const result = applySnapshot(canonical(base, false, false), live);
  expect(
    result.blocks
      .filter((block) => block.kind === "tool")
      .map((block) => block.callId),
  ).toEqual(["tool-a", "later-tool"]);
});

test("idle history gaps retain exact observed tools until canonical coverage settles them", () => {
  const base = selected();
  const live = applySnapshot(base);
  const pending = tool("pending-tool");
  pending.data = {
    ...(pending.data as object),
    round: 3,
    phase: "completed",
    result: "observed result",
  };
  applyEvent(live, pending);
  const missing = {
    ...base,
    session: { ...base.session, status: "idle" as const },
    history_gap: true,
  };
  const unresolved = applySnapshot(missing, live);
  const retained = unresolved.blocks.find(
    (block) => block.callId === "pending-tool",
  )!;
  expect(retained.payload.text).toBe("observed result");
  expect(retained.id).toBe(
    live.blocks.find((block) => block.callId === "pending-tool")!.id,
  );
  const rejected = canonical(base, false);
  rejected.messages = rejected.messages.map((message) =>
    message.role === "assistant"
      ? { ...message, position: { ...position, round: 3 } }
      : message,
  );
  rejected.session = { ...rejected.session, status: "idle" };
  const settled = applySnapshot(rejected, unresolved);
  expect(settled.blocks.some((block) => block.callId === "pending-tool")).toBe(
    false,
  );
  const other = {
    ...missing,
    history_view: { ...missing.history_view!, lineage: "another" },
  };
  expect(
    applySnapshot(other, unresolved).blocks.some(
      (block) => block.callId === "pending-tool",
    ),
  ).toBe(false);
});

test("an authoritative complete message can reject an unadmitted preview call", () => {
  const base = selected();
  const live = applySnapshot(base);
  applyEvent(live, tool("tool-a"));
  applyEvent(live, tool("unadmitted", 2));
  const admitted = applySnapshot(canonical(base, false), live);
  expect(
    admitted.blocks
      .filter((block) => block.kind === "tool")
      .map((block) => block.callId),
  ).toEqual(["tool-a"]);
});
