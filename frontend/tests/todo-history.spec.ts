import { test, expect } from "@playwright/test";
import { todosFromHistory } from "../src/client/client-tools";
import { createBlock, applySnapshot } from "../src/client/projector";
import { nativeSnapshot } from "./native-fixture";

test("todo projection follows selected successful results, including empty replacement and reused call IDs", () => {
  const first = createBlock("s", "hash_a", "same-call", "tool");
  first.callId = "same-call";
  first.clientInvocationId = "owned-client-invocation";
  first.tool = {
    name: "update_todo_list",
    status: "completed",
    input: { todos: [] },
  };
  first.payload.structured = {
    todos: [{ content: "first", status: "pending" }],
  };
  const otherBranch = {
    ...first,
    messageId: "hash_other",
    payload: {
      ...first.payload,
      structured: { todos: [{ content: "other branch", status: "cancelled" }] },
    },
  };
  const cleared = {
    ...first,
    messageId: "hash_clear",
    payload: { ...first.payload, structured: { todos: [] } },
  };
  const failed = {
    ...first,
    messageId: "hash_failed",
    payload: { ...first.payload, structured: { error: "failed" } },
  };
  expect(todosFromHistory([first, otherBranch])).toEqual([
    { content: "other branch", status: "cancelled" },
  ]);
  expect(todosFromHistory([first])).toEqual([
    { content: "first", status: "pending" },
  ]);
  expect(todosFromHistory([first, failed])).toEqual([
    { content: "first", status: "pending" },
  ]);
  expect(todosFromHistory([first, cleared])).toEqual([]);
});
test("truncated selected output resolves only its immutable invocation result", () => {
  const block = createBlock(
    "s",
    "hash_large_result",
    "reused-call",
    "tool",
    "tool",
  );
  block.tool = { name: "update_todo_list", status: "completed" };
  block.clientInvocationId = "exact_invocation";
  block.payload.text = '{"todos":[{"content":"truncated';
  const full = {
    todos: Array.from({ length: 200 }, (_, i) => ({
      content: `Task ${i} ${"x".repeat(170)}`,
      status: "pending",
    })),
  };
  expect(JSON.stringify(full).length).toBeGreaterThan(32768);
  expect(
    todosFromHistory(
      [block],
      new Map([
        ["other_branch", { todos: [] }],
        ["exact_invocation", full],
      ]),
    ),
  ).toHaveLength(200);
  expect(todosFromHistory([block], new Map([["other_branch", full]]))).toEqual(
    [],
  );
});
test("canonical tool-result merge preserves server invocation identity", () => {
  const transcript = applySnapshot({
    ...nativeSnapshot,
    messages: [
      {
        id: "hash_call",
        role: "assistant",
        text: null,
        parts: [],
        tool_calls: [
          { id: "c", name: "update_todo_list", arguments: { todos: [] } },
        ],
      },
      {
        id: "hash_result",
        role: "tool",
        text: '{"todos":[]}',
        parts: [],
        tool_calls: [],
        call_id: "c",
        tool_name: "update_todo_list",
        client_invocation_id: "immutable_id",
      },
    ],
  });
  expect(transcript.blocks).toHaveLength(1);
  expect(transcript.blocks[0].clientInvocationId).toBe("immutable_id");
});
