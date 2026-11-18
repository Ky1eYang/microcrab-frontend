import { expect, test } from "@playwright/test";
import {
  applyEvent,
  applySnapshot,
  replayDisplayObservations,
} from "../src/client/projector";
import { createConversationRegistry } from "../src/client/conversation/registry";
import { publishTranscript } from "../src/client/conversation/assembler";
import { applyDisplayGraphEnvelope } from "../src/client/display-graph";
import {
  binding,
  canonical,
  chunk,
  emit,
  graphRows,
  graphTranscript,
  message,
  producer,
  snapshot,
  terminal,
} from "./display-graph-inputs";

test("failed graph output stays before its operation error across recomposition", () => {
  const transcript = graphTranscript();
  emit(transcript, chunk(1, "thought", null, "reasoning", "thinking"));
  emit(transcript, chunk(2, "partial", "thought", "text", "partial answer"));
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
      status: "failed",
      result: { error: { code: "provider", message: "provider disconnected" } },
    } as any,
  });
  emit(transcript, terminal(4, 8, 14));
  expect(transcript.blocks.slice(0, 2).map((block) => block.id)).toEqual([
    "thought",
    "partial",
  ]);
  expect(transcript.blocks.at(-1)?.stream).toBe("error");
  expect(transcript.blocks.at(-1)?.payload.text).toContain(
    "provider disconnected",
  );
  emit(
    transcript,
    chunk(5, "later", "partial", "text", "later turn", {
      attempt: "later-attempt",
      extra: { operation_id: "later-operation" },
    }),
  );
  expect(transcript.blocks[2].stream).toBe("error");
  expect(transcript.blocks[3].id).toBe("later");
});

test("later canonical input stays after observed unbound graph output until its graph certificate arrives", () => {
  let transcript = graphTranscript();
  const first = message("first", "user", "first");
  emit(transcript, canonical(1, "first-node", null, first));
  emit(transcript, chunk(2, "partial", "first-node", "text", "partial"));
  const later = message("later", "user", "later");
  transcript = applySnapshot(snapshot([first, later]), transcript);
  expect(transcript.blocks.map((block) => block.payload.text)).toEqual([
    "first",
    "partial",
    "later",
  ]);
  emit(transcript, canonical(3, "later-node", "partial", later));
  expect(transcript.blocks.map((block) => block.id)).toEqual([
    "first-node",
    "partial",
    "later-node",
  ]);
});

test("older terminal replay cannot certify a newer invalidated attempt", () => {
  const transcript = graphTranscript();
  emit(transcript, chunk(1, "thought", null, "reasoning", "thought"));
  const invalidated = terminal(3, 7, 0);
  invalidated.event.phase = "invalidated";
  emit(transcript, invalidated);
  replayDisplayObservations(transcript, "s1", [terminal(2, 7, 0)]);
  expect(graphRows(transcript)[0].validated).toBe(false);
  expect(transcript.displayGraph!.terminals?.attempt).toBe("invalidated");
});

test("identical canonical IDs on retained siblings use the selected source occurrence", () => {
  const transcript = graphTranscript();
  const user = message("same-native-id", "user", "same body", {
    canonical_source_id: "source:old",
  });
  emit(transcript, canonical(1, "old", null, user));
  const replacement = message("same-native-id", "user", "same body", {
    canonical_source_id: "source:new",
  });
  emit(transcript, {
    sequence: 2,
    attempt_id: "selection",
    event: {
      ...producer,
      phase: "display_head_selected",
      display_head: { previous_block_id: "old", selected_block_id: null },
    },
  });
  emit(transcript, canonical(3, "new", null, replacement));
  const refreshed = applySnapshot(snapshot([replacement]), transcript);
  expect(refreshed.blocks.map((block) => block.id)).toEqual(["new"]);
  expect(refreshed.displayGraph!.nodes.old.canonical?.canonical_source_id).toBe(
    "source:old",
  );
});

test("immutable identity conflicts and overlapping chunks cannot certify content", () => {
  const transcript = graphTranscript();
  emit(transcript, chunk(1, "thought", null, "reasoning", "abc"));
  emit(
    transcript,
    chunk(2, "thought", null, "reasoning", "xx", {
      offset: 1,
      first: 1,
      head: false,
    }),
  );
  emit(transcript, terminal(3, 3, 0));
  expect(graphRows(transcript)[0].payload.text).toBe("abc");
  expect(graphRows(transcript)[0].validated).toBe(false);
  const conflict = chunk(4, "thought", "other-parent", "reasoning", "private");
  emit(transcript, conflict);
  expect(
    transcript.displayGraph!.nodes.thought.identity.parent_block_id,
  ).toBeNull();
  expect(graphRows(transcript)[0].payload.text).toBe("abc");
  expect(
    applyDisplayGraphEnvelope(transcript, "s1", {
      selected_head: "other",
      revision: 1,
      nodes: [],
      complete: true,
    }),
  ).toBe(false);
});

test("fork remap uses destination message identity while retaining inherited graph bytes", () => {
  const transcript = graphTranscript();
  const inherited = message("source-native", "user", "copied", {
    canonical_source_id: "stable-source",
  });
  emit(transcript, canonical(1, "retained-node", null, inherited));
  const frozen = structuredClone(
    transcript.displayGraph!.nodes["retained-node"].canonical,
  );
  const destination = message("destination-native", "user", "copied", {
    canonical_source_id: "stable-source",
  });
  emit(transcript, {
    sequence: 2,
    attempt_id: "fork",
    event: {
      ...producer,
      phase: "display_fork_remap",
      display_graph_version: 1,
      source_session_id: "source-session",
      target_session_id: "s1",
      context_epoch: 0,
      mappings: [
        {
          context_item_index: 0,
          canonical_source_id: "stable-source",
          source_canonical_message_id: "source-native",
          canonical_message_id: "destination-native",
          producer_block_ids: ["retained-node"],
          message: destination,
        },
      ],
    },
  });
  const refreshed = applySnapshot(snapshot([destination]), transcript);
  expect(refreshed.blocks.map((block) => [block.id, block.messageId])).toEqual([
    ["retained-node", "destination-native"],
  ]);
  expect(refreshed.displayGraph!.nodes["retained-node"].canonical).toEqual(
    frozen,
  );
});

test("accepted tool binding repairs partial arguments without inventing missing text segments", () => {
  const transcript = graphTranscript();
  emit(transcript, chunk(1, "tool-node", null, "tool_call", '{"path":'));
  const accepted = message("assistant", "assistant", "", {
    tool_calls: [{ id: "tool", name: "read", arguments: { path: "accepted" } }],
  });
  emit(transcript, binding(2, ["tool-node"], accepted));
  const tool = graphRows(transcript)[0];
  expect(tool.id).toBe("tool-node");
  expect(tool.tool.input).toEqual({ path: "accepted" });
  expect(tool.validated).toBe(true);
  expect(tool.stream).toBe("complete");
});

test("Context epoch changes retain display graph nodes and reading anchors in the same registry", () => {
  let transcript = graphTranscript();
  emit(transcript, chunk(1, "thought", null, "reasoning", "retained"));
  transcript.anchoredUserId = "reading-anchor";
  transcript.stickToBottom = false;
  transcript.scroll = "anchored";
  const registry = createConversationRegistry();
  publishTranscript(registry, transcript);
  const rendered = registry.getBlock("thought");
  const next = snapshot();
  next.history_view = {
    ...next.history_view!,
    lineage: "new-context",
    epoch: 1,
  };
  transcript = applySnapshot(next, transcript);
  publishTranscript(registry, transcript);
  expect(graphRows(transcript).map((block) => block.id)).toEqual(["thought"]);
  expect(registry.getBlock("thought")).toBe(rendered);
  expect(transcript.anchoredUserId).toBe("reading-anchor");
  expect(transcript.stickToBottom).toBe(false);
  registry.dispose();
});

test("canonical graph image resources retain their authenticated origin and exact identity", () => {
  const transcript = graphTranscript();
  const user = message("image-user", "user", "", {
    parts: [
      {
        type: "image",
        media_type: "image/png",
        source: { type: "url", url: "/api/v1/sessions/s1/images/image-user/0" },
      },
    ],
  });
  emit(transcript, canonical(1, "image-node", null, user));
  expect(graphRows(transcript)[0].payload.attachments[0].url).toBe(
    "http://127.0.0.1:4096/api/v1/sessions/s1/images/image-user/0",
  );
});

const permutations = [
  ["reasoning", "text", "tool_call"],
  ["reasoning", "tool_call", "text"],
  ["text", "reasoning", "tool_call"],
  ["text", "tool_call", "reasoning"],
  ["tool_call", "reasoning", "text"],
  ["tool_call", "text", "reasoning"],
];
for (const kinds of permutations) {
  test(`live and attach consume identical graph order: ${kinds.join("/")}`, () => {
    const user = message("user", "user", "question");
    const answer = message("answer", "assistant", "text", {
      tool_calls: [{ id: "tool", name: "read", arguments: {} }],
    });
    const records = [
      canonical(1, "user-node", null, user),
      ...kinds.map((kind, index) =>
        chunk(
          index + 2,
          `node-${index}`,
          index ? `node-${index - 1}` : "user-node",
          kind,
          kind === "tool_call" ? "{}" : kind,
        ),
      ),
      terminal(5, 9, 4),
      binding(6, ["node-0", "node-1", "node-2"], answer),
    ];
    let live = graphTranscript();
    for (const record of records) emit(live, record);
    const ids = graphRows(live).map((block) => block.id);
    expect(graphRows(live).map((block) => block.kind)).toEqual([
      "text",
      ...kinds.map((kind) => (kind === "tool_call" ? "tool" : kind)),
    ]);
    const idle = snapshot([user, answer]);
    idle.session.status = "idle";
    live = applySnapshot(idle, live);
    live = applySnapshot(idle, live);
    expect(graphRows(live).map((block) => block.id)).toEqual(ids);
    expect(
      live.blocks.filter((block) => block.payload.text === "text"),
    ).toHaveLength(1);
    const attached = applySnapshot(idle);
    replayDisplayObservations(attached, "s1", records);
    expect(graphRows(attached).map((block) => block.id)).toEqual(ids);
    expect(graphRows(attached).map((block) => block.kind)).toEqual(
      graphRows(live).map((block) => block.kind),
    );
    expect(
      graphRows(live).find((block) => block.kind === "reasoning")?.stream,
    ).toBe("complete");
  });
}

test("literal chronological thinking segments remain separate around text and tools", () => {
  let transcript = graphTranscript();
  const records = [
    chunk(1, "thought-1", null, "reasoning", "first"),
    chunk(2, "answer", "thought-1", "text", "answer"),
    chunk(3, "thought-2", "answer", "reasoning", "second"),
    chunk(4, "tool-node", "thought-2", "tool_call", "{}"),
    terminal(5, 11, 6),
  ];
  records.forEach((record) => emit(transcript, record));
  expect(graphRows(transcript).map((block) => block.id)).toEqual([
    "thought-1",
    "answer",
    "thought-2",
    "tool-node",
  ]);
  expect(
    graphRows(transcript)
      .filter((block) => block.kind === "reasoning")
      .map((block) => block.payload.text),
  ).toEqual(["first", "second"]);
  transcript = applySnapshot(snapshot(), transcript);
  expect(
    graphRows(transcript)
      .filter((block) => block.kind === "reasoning")
      .every((block) => block.validated),
  ).toBe(true);
  const reloaded = graphTranscript();
  replayDisplayObservations(reloaded, "s1", records);
  expect(graphRows(reloaded).map((block) => block.id)).toEqual(
    graphRows(transcript).map((block) => block.id),
  );
});

test("retry retains immutable siblings and selects only the certified new parent path", () => {
  const transcript = graphTranscript();
  const a = chunk(1, "a", null, "text", "a");
  const b = chunk(2, "b", "a", "reasoning", "b");
  const c = chunk(3, "c", "b", "text", "old");
  [a, b, c].forEach((record) => emit(transcript, record));
  const frozen = structuredClone({
    identity: transcript.displayGraph!.nodes.c.identity,
    chunks: transcript.displayGraph!.nodes.c.chunks,
  });
  emit(transcript, {
    sequence: 4,
    attempt_id: "selection",
    event: {
      ...c.event,
      display_block: undefined,
      phase: "display_head_selected",
      display_head: { previous_block_id: "c", selected_block_id: "b" },
    },
  });
  const d = chunk(5, "d", "b", "text", "new", { attempt: "retry" });
  emit(transcript, d);
  expect(graphRows(transcript).map((block) => block.id)).toEqual([
    "a",
    "b",
    "d",
  ]);
  expect({
    identity: transcript.displayGraph!.nodes.c.identity,
    chunks: transcript.displayGraph!.nodes.c.chunks,
  }).toEqual(frozen);
  const oldGraph = {
    selected_head: "c",
    revision: 3,
    nodes: [a, b, c].map((record) => record.event.display_block as any),
    complete: true,
  };
  expect(applyDisplayGraphEnvelope(transcript, "s1", oldGraph)).toBe(true);
  expect(graphRows(transcript).map((block) => block.id)).toEqual([
    "a",
    "b",
    "d",
  ]);
  expect(transcript.displayGraph!.selectedHead).toBe("d");
});

test("UTF8 gaps, duplicate replay and terminal-before-prefix never claim absent suffix coverage", () => {
  const transcript = graphTranscript();
  const prefix = chunk(1, "thought", null, "reasoning", "你");
  const suffix = chunk(2, "thought", null, "reasoning", "好", {
    offset: 3,
    first: 1,
    head: false,
  });
  emit(transcript, suffix);
  replayDisplayObservations(transcript, "s1", [terminal(3, 6, 0)]);
  expect(graphRows(transcript)).toHaveLength(0); // No selected-head certificate yet.
  emit(transcript, prefix);
  expect(graphRows(transcript)[0].payload.text).toBe("你好");
  expect(graphRows(transcript)[0].validated).toBe(true);
  replayDisplayObservations(transcript, "s1", [prefix, suffix]);
  expect(graphRows(transcript)[0].payload.text).toBe("你好");
  const partial = graphTranscript();
  emit(partial, prefix);
  emit(partial, terminal(3, 6, 0));
  expect(graphRows(partial)[0].validated).toBe(false);
  expect(graphRows(partial)[0].displayIncomplete).toBe(true);
});

test("unknown ancestry and bounded graph pages retain known display evidence", () => {
  const transcript = graphTranscript();
  const a = chunk(1, "a", null, "reasoning", "retained");
  emit(transcript, a);
  const later = chunk(4, "later", "unknown", "text", "later");
  emit(transcript, later);
  expect(transcript.displayGraph!.incomplete).toBe(true);
  expect(graphRows(transcript).map((block) => block.id)).toContain("a");
  applyDisplayGraphEnvelope(transcript, "s1", {
    selected_head: "later",
    revision: 4,
    nodes: [],
    complete: true,
  });
  expect(graphRows(transcript).map((block) => block.id)).toContain("a");
  const independent = graphTranscript();
  expect(independent.displayGraph).toBeUndefined();
});

test("tool results enrich the exact selected graph invocation after provider completion", () => {
  const transcript = graphTranscript();
  const assistant = message("assistant", "assistant", "answer", {
    tool_calls: [{ id: "tool", name: "read", arguments: {} }],
  });
  const result = message("result", "tool", "done", {
    call_id: "tool",
    tool_name: "read",
  });
  [
    chunk(1, "thought", null, "reasoning", "think"),
    chunk(2, "tool-node", "thought", "tool_call", "{}"),
    chunk(3, "answer", "tool-node", "text", "answer"),
    terminal(4, 5, 6),
    binding(5, ["thought", "tool-node", "answer"], assistant),
    canonical(6, "result-node", "answer", result),
  ].forEach((record) => emit(transcript, record));
  const card = graphRows(transcript).find((block) => block.id === "tool-node")!;
  expect(card.payload.text).toBe("done");
  expect(card.tool.status).toBe("completed");
  expect(graphRows(transcript).map((block) => block.id)).toEqual([
    "thought",
    "tool-node",
    "answer",
  ]);
  const refreshed = applySnapshot(snapshot([assistant, result]), transcript);
  expect(
    graphRows(refreshed).find((block) => block.id === "tool-node")?.payload
      .text,
  ).toBe("done");
  expect(
    graphRows(refreshed).filter((block) => block.kind === "reasoning"),
  ).toHaveLength(1);
});
