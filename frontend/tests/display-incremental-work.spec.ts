import { expect, test } from "@playwright/test";
import { applySnapshot, flushProjectedDisplay } from "../src/client/projector";
import {
  applyDisplayBatch,
  DisplayFragments,
  replayDisplayObservations,
} from "../src/client/display-replay";
import {
  cloneDisplayGraph,
  displayProjectionWork,
} from "../src/client/display-graph";
import { publishTranscript } from "../src/client/conversation/assembler";
import {
  createConversationRegistry,
  registryPublicationWork,
} from "../src/client/conversation/registry";
import type {
  NativeDisplayBatch,
  NativeDisplayRecord,
  NativeEvent,
  Transcript,
} from "../src/client/types";
import {
  binding,
  canonical,
  chunk,
  graphRows,
  graphTranscript,
  message,
  snapshot,
  terminal,
} from "./display-graph-inputs";

function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const nested of Object.values(value)) freeze(nested);
}
function fullReference(t: Transcript, records: NativeDisplayRecord[]): void {
  for (const record of records) {
    // Drop only optimization ownership. Keep the exact reconciliation algorithm
    // and place every first content witness before ingesting the next record.
    if (t.displayGraph) t.displayGraph = cloneDisplayGraph(t.displayGraph);
    replayDisplayObservations(t, "s1", [record]);
  }
}
function rows(t: Transcript) {
  return graphRows(t).map((block) => structuredClone(block));
}
function batch(
  records: NativeDisplayRecord[],
  after = 0,
  through = records.at(-1)?.sequence ?? after,
): NativeDisplayBatch {
  return {
    records,
    after,
    scanned_through: through,
    high_water: through,
    next_cursor: null,
    history_lineage: "selected",
    coverage: "available",
  };
}

test("one batch composes once and explicit ingestion does not publish intermediate rows", () => {
  const t = graphTranscript();
  const records = [
    chunk(1, "a", null, "text", "a"),
    chunk(2, "a", null, "text", "b", { first: 1, offset: 1 }),
  ];
  const before = displayProjectionWork.compositions;
  expect(applyDisplayBatch(t, "s1", batch(records))).toBe(true);
  expect(displayProjectionWork.compositions - before).toBe(1);
  expect(graphRows(t)[0].payload.text).toBe("ab");
  const next = chunk(3, "a", null, "text", "c", { first: 1, offset: 2 });
  expect(applyDisplayBatch(t, "s1", batch([next], 2), false)).toBe(true);
  expect(graphRows(t)[0].payload.text).toBe("ab");
  expect(t.displayReplay!.watermark).toBe(3);
  flushProjectedDisplay(t, "s1");
  expect(graphRows(t)[0].payload.text).toBe("abc");
});

test("100 rounds and 16000 records keep unchanged bodies and bounded live node work", () => {
  const t = graphTranscript();
  const records: NativeDisplayRecord[] = [];
  let sequence = 0;
  for (let round = 0; round < 100; round++) {
    const first = sequence + 1;
    for (let part = 0; part < 160; part++)
      records.push(
        chunk(
          ++sequence,
          `round:${round}`,
          round ? `round:${round - 1}` : null,
          "text",
          "x\u03bb",
          {
            first,
            offset: part * 3,
            attempt: `attempt:${round}`,
          },
        ),
      );
  }
  const composed = displayProjectionWork.compositions;
  replayDisplayObservations(t, "s1", records);
  expect(displayProjectionWork.compositions - composed).toBe(1);
  expect(graphRows(t)).toHaveLength(100);
  const untouched = t.blocks.slice(0, 99);
  const full = displayProjectionWork.full;
  const bodies = displayProjectionWork.nodeBodies;
  const live = displayProjectionWork.liveNodes;
  const active = records.at(-1)!;
  for (let part = 160; part < 180; part++) {
    const record = structuredClone(active);
    record.sequence = ++sequence;
    (record.event.display_block as { content_offset: number }).content_offset =
      part * 3;
    replayDisplayObservations(t, "s1", [record]);
  }
  expect(displayProjectionWork.full).toBe(full);
  expect(displayProjectionWork.nodeBodies).toBe(bodies);
  expect(displayProjectionWork.liveNodes - live).toBe(20);
  untouched.forEach((block, index) => expect(t.blocks[index]).toBe(block));
  expect(t.displayGraph!.nodes["round:99"].invalid).not.toBe(true);
  expect(graphRows(t).at(-1)!.payload.text).toBe("x\u03bb".repeat(180));
});

test("incremental and forced full reconciliation agree on gaps, overlap, binding and exact tool handoff", () => {
  const assistant = message("assistant", "assistant", "answer", {
    tool_calls: [{ id: "tool", name: "read", arguments: { path: "a" } }],
  });
  const records = [
    chunk(1, "thought", null, "reasoning", "a"),
    chunk(3, "thought", null, "reasoning", "c", { first: 1, offset: 2 }),
    chunk(2, "thought", null, "reasoning", "b", { first: 1, offset: 1 }),
    chunk(4, "answer", "thought", "text", "answer"),
    chunk(5, "tool", "answer", "tool_call", '{"path":"a"}'),
    terminal(6, 3, 6),
    binding(7, ["thought", "answer", "tool"], assistant),
    canonical(
      8,
      "unrelated-result",
      "tool",
      message("unrelated", "tool", "wrong", { call_id: "other" }),
    ),
    canonical(
      9,
      "result",
      "unrelated-result",
      message("result", "tool", "correct", { call_id: "tool" }),
    ),
  ];
  const actual = graphTranscript();
  const reference = graphTranscript();
  for (const record of records) {
    replayDisplayObservations(actual, "s1", [record]);
    fullReference(reference, [record]);
    expect(rows(actual)).toEqual(rows(reference));
    expect(actual.displayReplay!.watermark).toBe(
      reference.displayReplay!.watermark,
    );
    expect(actual.displayGraph!.incomplete).toBe(
      reference.displayGraph!.incomplete,
    );
  }
  expect(
    graphRows(actual).find((block) => block.callId === "tool")!.payload.text,
  ).toBe("correct");
  expect(
    graphRows(actual).find((block) => block.callId === "other")!.payload.text,
  ).toBe("wrong");
  // A conflicting overlapping byte range must remain incomplete after terminal.
  const overlap = chunk(10, "thought", null, "reasoning", "bad", {
    first: 1,
    offset: 1,
  });
  replayDisplayObservations(actual, "s1", [overlap]);
  fullReference(reference, [overlap]);
  expect(rows(actual)).toEqual(rows(reference));
  expect(graphRows(actual)[0].validated).toBe(false);
});

test("batched ingestion preserves certified graph order, remap identity and source suppression", () => {
  const accepted = message("accepted", "assistant", "accepted");
  const records = [
    canonical(1, "user", null, message("user", "user", "question")),
    chunk(2, "answer", "user", "text", "accepted"),
    binding(3, ["answer"], accepted),
    terminal(4, 0, 8),
    {
      sequence: 5,
      attempt_id: "fork",
      event: {
        phase: "display_fork_remap",
        call_id: "provider",
        epoch: 0,
        turn: 1,
        round: 1,
        target_session_id: "s1",
        mappings: [
          {
            canonical_source_id: accepted.canonical_source_id,
            canonical_message_id: "forked",
            message: { ...accepted, id: "forked" },
          },
        ],
      },
    },
  ];
  const reference = graphTranscript();
  fullReference(reference, records);
  const t = graphTranscript();
  replayDisplayObservations(t, "s1", records);
  expect(rows(t)).toEqual(rows(reference));
  expect(graphRows(t).map((block) => block.id)).toEqual(["user", "answer"]);
  expect(graphRows(t)[1].messageId).toBe("forked");
  expect(graphRows(t)[1].canonicalSourceId).toBe(accepted.canonical_source_id);
});

test("frozen prior graph remains pure through snapshot, terminal and fork remap projection", () => {
  const prior = graphTranscript();
  replayDisplayObservations(prior, "s1", [chunk(1, "a", null, "text", "body")]);
  const before = structuredClone(prior);
  freeze(prior);
  const next = applySnapshot(snapshot(), prior);
  replayDisplayObservations(next, "s1", [terminal(2, 0, 4)]);
  expect(prior).toEqual(before);
  expect(next.displayGraph).not.toBe(prior.displayGraph);
  expect(next.displayGraph!.nodes.a).not.toBe(prior.displayGraph!.nodes.a);
  expect(graphRows(next)[0].validated).toBe(true);
});

test("page scan watermark does not cross missing pages or stale lineage", () => {
  const t = graphTranscript();
  expect(
    applyDisplayBatch(
      t,
      "s1",
      batch([chunk(5, "a", null, "text", "a")], 4, 8),
      false,
    ),
  ).toBe(true);
  expect(t.displayReplay!.watermark).toBe(0);
  const stale = { ...batch([], 0, 4), history_lineage: "other" };
  expect(applyDisplayBatch(t, "s1", stale, false)).toBe(false);
  expect(t.displayReplay!.watermark).toBe(0);
  expect(applyDisplayBatch(t, "s1", batch([], 0, 4), false)).toBe(true);
  expect(t.displayReplay!.watermark).toBe(5);
});

test("registry detects in-place completion and nested metadata with independent child ownership", () => {
  const main = graphTranscript();
  replayDisplayObservations(main, "s1", [chunk(1, "a", null, "text", "body")]);
  const child = graphTranscript();
  replayDisplayObservations(child, "s1", [
    chunk(1, "a", null, "text", "child"),
  ]);
  const mainRegistry = createConversationRegistry();
  const childRegistry = createConversationRegistry();
  publishTranscript(mainRegistry, main);
  publishTranscript(childRegistry, child);
  const childVersion = childRegistry.version("a");
  const block = graphRows(main)[0];
  block.payload.providerMetadata = { nested: { count: 1 } };
  publishTranscript(mainRegistry, main);
  const version = mainRegistry.version("a");
  (
    block.payload.providerMetadata as { nested: { count: number } }
  ).nested.count = 2;
  block.stream = "complete";
  expect(publishTranscript(mainRegistry, main)).toBe("structure");
  expect(mainRegistry.version("a")).toBeGreaterThan(version);
  expect(childRegistry.version("a")).toBe(childVersion);
  expect(childRegistry.getBlock("a")!.payload.text).toBe("child");
  expect(mainRegistry.getBlock("a")).not.toBe(block);
  expect(publishTranscript(mainRegistry, main)).toBe("none");
  mainRegistry.dispose();
  childRegistry.dispose();
});

function fragment(index: number, text: string, last = false): NativeEvent {
  return {
    v: 1,
    type: "event",
    session_id: "s1",
    subscription_id: "sub",
    generation: "g",
    sequence: index + 1,
    event: "display.fragment",
    data: {
      id: "page",
      index,
      text,
      last,
      event: "display.batch",
      history_lineage: "selected",
    },
  } as NativeEvent;
}
test("fragment failures are explicit, never parsed into committed display pages", () => {
  const fragments = new DisplayFragments();
  expect(fragments.receive(fragment(0, "{"))).toBeNull();
  expect(fragments.receive(fragment(2, "}", true))).toBeNull();
  expect(fragments.takeFailure()).toContain("out-of-order");
  expect(fragments.takeFailure()).toBeNull();
  expect(fragments.receive(fragment(0, "invalid", true))).toBeNull();
  expect(fragments.takeFailure()).toContain("JSON");
  const payload = JSON.stringify(batch([]));
  expect(fragments.receive(fragment(0, payload, true))!.event).toBe(
    "display.batch",
  );
});

test("fragment aggregate limit includes UTF-8 bytes across scopes and resets on generation", () => {
  const fragments = new DisplayFragments();
  // Reuse one bounded chunk; no giant serialized fixture or private data.
  const text = "\u03bb".repeat(512 * 1024);
  for (let index = 0; index < 128; index++)
    expect(fragments.receive(fragment(index, text))).toBeNull();
  expect(fragments.takeFailure()).toBeNull();
  expect(fragments.receive(fragment(128, "\u03bb"))).toBeNull();
  expect(fragments.takeFailure()).toContain("128 MiB");
  const event = fragment(0, JSON.stringify(batch([])), true);
  event.generation = "new";
  expect(fragments.receive(event)!.event).toBe("display.batch");
});

test("missing ancestry and terminal byte totals never certify omitted content", () => {
  const actual = graphTranscript();
  const reference = graphTranscript();
  const records = [
    chunk(2, "tail", "missing", "reasoning", "\u03b2", { attempt: "a" }),
    terminal(3, 3, 0, "a"),
    chunk(1, "missing", null, "text", "root", { attempt: "root" }),
  ];
  for (const record of records) {
    replayDisplayObservations(actual, "s1", [record]);
    fullReference(reference, [record]);
    expect(rows(actual)).toEqual(rows(reference));
    expect(actual.displayGraph!.incomplete).toBe(
      reference.displayGraph!.incomplete,
    );
  }
  expect(actual.displayGraph!.incomplete).toBe(false);
  expect(graphRows(actual).map((block) => block.id)).toEqual([
    "missing",
    "tail",
  ]);
  expect(graphRows(actual)[1].validated).toBe(false);
  expect(graphRows(actual)[1].displayIncomplete).toBe(true);
  // A later exact terminal receipt may repair total coverage, never terminal time placement.
  replayDisplayObservations(actual, "s1", [terminal(4, 2, 0, "a")]);
  fullReference(reference, [terminal(4, 2, 0, "a")]);
  expect(rows(actual)).toEqual(rows(reference));
  expect(graphRows(actual)[1].validated).toBe(true);
  expect(graphRows(actual).map((block) => block.id)).toEqual([
    "missing",
    "tail",
  ]);
});

test("registry skips only proven immutable heavy metadata and still detects mutable stream fields", () => {
  const t = graphTranscript();
  replayDisplayObservations(t, "s1", [chunk(1, "a", null, "text", "body")]);
  const metadata = {
    entries: Array.from({ length: 1000 }, (_, id) => ({
      id,
      text: `metadata:${id}`,
    })),
  };
  freeze(metadata);
  graphRows(t)[0].payload.providerMetadata = metadata;
  const registry = createConversationRegistry();
  publishTranscript(registry, t);
  expect(Object.isFrozen(registry.getBlock("a")!.payload)).toBe(true);
  publishTranscript(registry, t); // Establish equality of the two immutable trees once.
  const compared = registryPublicationWork.comparisons;
  const hits = registryPublicationWork.immutableHits;
  expect(publishTranscript(registry, t)).toBe("none");
  expect(registryPublicationWork.comparisons - compared).toBeLessThan(100);
  expect(registryPublicationWork.immutableHits).toBeGreaterThan(hits);
  graphRows(t)[0].stream = "stopped";
  expect(publishTranscript(registry, t)).toBe("structure");
  expect(registry.getBlock("a")!.stream).toBe("stopped");
  registry.dispose();
});
