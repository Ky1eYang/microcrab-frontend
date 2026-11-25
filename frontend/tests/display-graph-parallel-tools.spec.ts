import { expect, test } from "@playwright/test";
import {
  applySnapshot,
  replayDisplayObservations,
} from "../src/client/projector";
import {
  binding,
  canonical,
  chunk,
  emit,
  graphRows,
  graphTranscript,
  message,
  snapshot,
  terminal,
} from "./display-graph-inputs";
import type { NativeDisplayRecord } from "../src/client/types";

function tool(
  sequence: number,
  blockId: string,
  parent: string | null,
  index: number,
  args: string,
  options: { first?: number; offset?: number; initial?: boolean } = {},
): NativeDisplayRecord {
  const record = chunk(sequence, blockId, parent, "tool_call", args, {
    first: options.first,
    offset: options.offset,
    head: options.first == null,
  });
  const meta = record.event.display_block as { stream_key: string };
  meta.stream_key = `tool:${index}`;
  record.event.index = index;
  if (options.initial) {
    record.event.id = `t${index}`;
    record.event.name = index === 0 ? "read" : "delegate";
  } else {
    delete record.event.id;
    delete record.event.name;
  }
  return record;
}

function scenario() {
  const records = [
    tool(1, "tool0-first", null, 0, "", { initial: true }),
    tool(2, "tool0-first", null, 0, '{"path":', { first: 1 }),
    tool(3, "tool1-first", "tool0-first", 1, "", { initial: true }),
    tool(4, "tool1-first", "tool0-first", 1, '{"prompt":', { first: 3 }),
    tool(5, "tool0-suffix", "tool1-first", 0, '"file"}'),
    tool(6, "tool1-suffix", "tool0-suffix", 1, '"work"}'),
    terminal(7, 0, 0),
  ];
  const assistant = message("assistant", "assistant", "", {
    tool_calls: [
      { id: "t0", name: "read", arguments: { path: "file" } },
      {
        id: "t1",
        name: "delegate",
        builtin: "delegate",
        arguments: { prompt: "work" },
      },
    ],
  });
  records.push(
    binding(
      8,
      ["tool0-first", "tool1-first", "tool0-suffix", "tool1-suffix"],
      assistant,
    ),
  );
  records.push(
    canonical(
      9,
      "result0",
      "tool1-suffix",
      message("result0", "tool", "file contents", {
        call_id: "t0",
        tool_name: "read",
        parts: [
          {
            type: "image",
            source: {
              type: "url",
              url: "/api/v1/sessions/s1/images/result0/0",
            },
          },
        ],
      }),
    ),
  );
  records.push(
    canonical(
      10,
      "result1",
      "result0",
      message(
        "result1",
        "tool",
        JSON.stringify({ execution_id: 7, session_id: "s1" }),
        { call_id: "t1", tool_name: "delegate", tool_builtin: "delegate" },
      ),
    ),
  );
  return records;
}

function childSnapshot() {
  const view = snapshot();
  view.executions = [
    {
      execution_id: 7,
      session_id: "s1",
      call_id: "t1",
      tool: "delegate",
      agent: "main",
      mode: null,
      capabilities: { input: false },
      status: "running",
      delegate_child: { session_id: "child", target: "worker" },
    },
  ];
  return view;
}
function cards(transcript: ReturnType<typeof graphTranscript>) {
  return graphRows(transcript).filter(
    (block) => block.kind === "tool" || block.kind === "child",
  );
}

test("interleaved parallel tool segments keep one first-appearance card per invocation live and attach", () => {
  const records = scenario();
  let live = applySnapshot(childSnapshot());
  for (const record of records.slice(0, 6)) emit(live, record);
  expect(
    cards(live).map((block) => [block.id, block.callId, block.tool.input]),
  ).toEqual([
    ["tool0-first", "t0", { path: "file" }],
    ["tool1-first", "t1", { prompt: "work" }],
  ]);
  expect(Object.keys(live.displayGraph!.nodes)).toHaveLength(4);
  expect(live.displayGraph!.nodes["tool0-first"].invalid).not.toBe(true);
  records.slice(6).forEach((record) => emit(live, record));
  const originalIds = cards(live).map((block) => block.id);
  expect(originalIds).toEqual(["tool0-first", "tool1-first"]);
  expect(cards(live)[0].payload.text).toBe("file contents");
  expect(cards(live)[0].payload.attachments).toEqual([
    expect.objectContaining({
      url: expect.stringContaining("/images/result0/0"),
      sourceOmitted: false,
    }),
  ]);
  expect(cards(live)[1].kind).toBe("child");
  expect(cards(live)[1].tool.childSessionId).toBe("child");
  expect(cards(live).filter((block) => block.executionId === 7)).toHaveLength(
    1,
  );
  live = applySnapshot(childSnapshot(), live);
  expect(cards(live).map((block) => block.id)).toEqual(originalIds);
  const attached = applySnapshot(childSnapshot());
  replayDisplayObservations(attached, "s1", records);
  expect(
    cards(attached).map((block) => [
      block.id,
      block.callId,
      block.kind,
      block.tool.input,
      block.payload.text,
    ]),
  ).toEqual(
    cards(live).map((block) => [
      block.id,
      block.callId,
      block.kind,
      block.tool.input,
      block.payload.text,
    ]),
  );
  replayDisplayObservations(attached, "s1", [...records].reverse());
  expect(cards(attached)).toHaveLength(2);
});

test("parallel tool metadata may arrive after its suffix and admitted index supplies missing invocation identity", () => {
  const records = scenario();
  const transcript = graphTranscript();
  replayDisplayObservations(transcript, "s1", [...records].reverse());
  expect(
    cards(transcript).map((block) => [
      block.id,
      block.callId,
      block.tool.input,
    ]),
  ).toEqual([
    ["tool0-first", "t0", { path: "file" }],
    ["tool1-first", "t1", { prompt: "work" }],
  ]);
  const noId = graphTranscript();
  const initial = tool(1, "only", null, 1, "{}");
  emit(noId, initial);
  expect(cards(noId)[0].callId).toBeUndefined();
  emit(
    noId,
    binding(
      2,
      ["only"],
      message("accepted", "assistant", "", {
        tool_calls: [
          { id: "t0", name: "read", arguments: {} },
          { id: "t1", name: "delegate", arguments: { prompt: "accepted" } },
        ],
      }),
    ),
  );
  expect(cards(noId)[0].callId).toBe("t1");
  expect(cards(noId)[0].tool.input).toEqual({ prompt: "accepted" });
});
