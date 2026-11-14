import { expect, test } from "@playwright/test";
import {
  applyEvent,
  applySnapshot,
  computeTurns,
  createBlock,
} from "../src/client/projector";
import { groupBlocks } from "../src/features/conversation/groupBlocks";
import { orderedCards } from "../src/features/conversation/orderedCards";
import { nativeSnapshot } from "./native-fixture";

function observedTools() {
  const transcript = applySnapshot({ ...nativeSnapshot, operations: [] });
  const observe = (round: number, phase: string, extra = {}) =>
    applyEvent(transcript, {
      v: 1,
      type: "event",
      subscription_id: "sub",
      generation: "g",
      sequence: round,
      session_id: "s1",
      event: "model_observation",
      data: {
        operation_id: "turn",
        call_id: `request-${round}`,
        epoch: 0,
        turn: 1,
        round,
        phase,
        ...extra,
      },
    });
  for (const round of [1, 2, 3]) {
    observe(round, "started");
    observe(round, "tool_call_delta", {
      index: 0,
      id: `call-${round}`,
      name: "read",
      arguments: "{}",
    });
    observe(round, "validated", { text: "" });
  }
  return transcript;
}

const groups = (blocks: Parameters<typeof groupBlocks>[0]) =>
  groupBlocks(blocks).filter((item) => item.type === "tools");

test("native empty request previews bridge tool rounds without rewriting transcript or navigation", () => {
  const transcript = observedTools();
  const before = structuredClone(transcript);
  const turns = computeTurns(transcript);
  const rows = orderedCards(transcript.blocks, [], null, "s1", new Map());
  expect(
    groups(rows).map((group) =>
      group.blocks.map((block) => block.tool?.callId),
    ),
  ).toEqual([["call-1", "call-2", "call-3"]]);
  expect(
    transcript.blocks.filter((block) => block.preview && block.kind === "text"),
  ).toHaveLength(3);
  expect(transcript).toEqual(before);
  expect(computeTurns(transcript)).toEqual(turns);
});

test("explicit empty model-request markers bridge tools, including consecutive markers", () => {
  const tools = observedTools().blocks.filter((block) => block.kind === "tool");
  const marker = createBlock("s1", "input", "point", "model-request");
  const second = { ...marker, id: `${marker.id}-2` };
  expect(groups([tools[0], marker, second, tools[1]])[0].blocks).toEqual([
    tools[0],
    tools[1],
  ]);
});

test("visible content and non-request records remain tool-group boundaries", () => {
  const transcript = observedTools();
  const tools = transcript.blocks.filter((block) => block.kind === "tool");
  const preview = transcript.blocks.find(
    (block) => block.preview && block.kind === "text",
  )!;
  const ordinary = createBlock("s1", "empty-assistant", "text");
  const barriers = [
    {
      ...preview,
      payload: { ...preview.payload, text: "Visible assistant reply" },
    },
    { ...preview, payload: { ...preview.payload, text: " " } },
    {
      ...preview,
      kind: "reasoning",
      payload: { ...preview.payload, text: "Thinking" },
    },
    { ...preview, kind: "reasoning" },
    { ...preview, role: "user" },
    { ...preview, kind: "error", stream: "error" },
    { ...preview, stream: "error" },
    {
      ...preview,
      payload: {
        ...preview.payload,
        failure: { code: "failed", message: "Failure" },
      },
    },
    {
      ...preview,
      payload: {
        ...preview.payload,
        attachments: [{ marker: "[Image]", sourceOmitted: true }],
      },
    },
    { ...preview, isCompact: true },
    { ...preview, kind: "compaction" },
    { ...preview, kind: "question", role: "system" },
    { ...preview, kind: "compact-command", role: "system" },
    ordinary,
  ];
  for (const barrier of barriers) {
    const items = groupBlocks([tools[0], preview, barrier, preview, tools[1]]);
    expect(
      items.filter((item) => item.type === "tools"),
      barrier.kind,
    ).toHaveLength(2);
    expect(items.flatMap((item) => item.blocks)).toContain(barrier);
  }
});

test("ordered pending cards prevent merging across native request previews", () => {
  const transcript = observedTools();
  const tools = transcript.blocks.filter((block) => block.kind === "tool");
  const preview = transcript.blocks.find(
    (block) => block.preview && block.kind === "text",
  )!;
  const blocks = [tools[0], preview, tools[1]];
  const question = {
    id: "question",
    sessionId: "s1",
    callId: tools[0].callId,
    epoch: 0,
    turnId: 1,
    roundId: 1,
  };
  tools[0].position = { epoch: 0, turn: 1, round: 1 };
  const rows = orderedCards(blocks, [question], null, "s1", new Map());
  expect(rows.map((block) => block.kind)).toEqual([
    "tool",
    "question",
    "text",
    "tool",
  ]);
  expect(groups(rows)).toHaveLength(2);
  const compactRows = orderedCards(
    blocks,
    [],
    {
      operation_id: "compact",
      status: "running",
      sessionId: "s1",
    },
    "s1",
    new Map([
      ["s1:compact:compact:card", { after: tools[0].id, before: preview.id }],
    ]),
  );
  expect(compactRows.map((block) => block.kind)).toEqual([
    "tool",
    "compact-command",
    "text",
    "tool",
  ]);
  expect(groups(compactRows)).toHaveLength(2);
});

test("invisible requests do not merge subagent groups or reorder tools around subagents", () => {
  const transcript = observedTools();
  const tools = transcript.blocks.filter((block) => block.kind === "tool");
  const preview = transcript.blocks.find(
    (block) => block.preview && block.kind === "text",
  )!;
  const child = {
    ...tools[0],
    kind: "child",
    tool: { ...tools[0].tool!, childSessionId: "child" },
  };
  expect(
    groupBlocks([child, preview, { ...child, id: "child-2" }]).map(
      (item) => item.type,
    ),
  ).toEqual(["subagents", "single", "subagents"]);
  expect(
    groupBlocks([tools[0], preview, child, tools[1]]).map((item) => item.type),
  ).toEqual(["tools", "single", "subagents", "tools"]);
});
