import { test, expect } from "@playwright/test";
import {
  applyEvent,
  applySnapshot,
  createBlock,
} from "../src/client/projector";
import { isSubagent, childId } from "../src/features/shared";
import { toolArgsSummary } from "../src/features/views";
import { todosFromHistory } from "../src/client/client-tools";
import { nativeSnapshot } from "./native-fixture";

test("untrusted delegate names and result fields never manufacture child navigation", () => {
  const transcript = applySnapshot({
    ...nativeSnapshot,
    messages: [
      {
        id: "call",
        role: "assistant",
        text: null,
        parts: [],
        tool_calls: [{ id: "c", name: "delegate", arguments: {} }],
      },
      {
        id: "result",
        role: "tool",
        call_id: "c",
        tool_name: "delegate",
        text: '{"child_id":"untrusted-child","sessionID":"other-child"}',
        parts: [],
        tool_calls: [],
      },
    ],
  });
  const block = transcript.blocks[0];
  expect(isSubagent(block)).toBe(false);
  expect(childId(block)).toBe("");
  applyEvent(transcript, {
    v: 1,
    type: "event",
    subscription_id: "sub",
    generation: "g",
    sequence: 1,
    session_id: "s1",
    event: "tool",
    data: {
      call_id: "live",
      name: "delegate",
      phase: "completed",
      result: '{"child_id":"untrusted-live-child"}',
    },
  });
  expect(
    transcript.blocks.every(
      (item) => !isSubagent(item) && childId(item) === "",
    ),
  ).toBe(true);
});

test("same-named WASM todo JSON has no definition-owned presentation", () => {
  const block = createBlock("s", "m", "c", "tool");
  block.tool = { name: "update_todo_list", status: "completed", input: {} };
  block.payload.text =
    '{"todos":[{"content":"must remain opaque","status":"pending"}]}';
  expect(todosFromHistory([block])).toEqual([]);
});

test("tool argument summaries do not guess tool semantics by export name", () => {
  const block = createBlock("s", "m", "c", "tool");
  block.tool = {
    name: "shell",
    status: "completed",
    input: { command: "opaque", other: 42 },
  };
  const shellSummary = toolArgsSummary(block);
  block.tool.name = "unrelated_export";
  expect(toolArgsSummary(block)).toBe(shellSummary);
  expect(shellSummary).toBe("command=opaque, other=42");
});
