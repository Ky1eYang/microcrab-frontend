import { expect, test } from "@playwright/test";
import { applySnapshot } from "../src/client/projector";
import {
  mergeHistoryPage,
  retainLoadedMessages,
} from "../src/client/loaded-messages";
import { replayDisplayObservations } from "../src/client/display-replay";
import type { NativeDisplayRecord, NativeMessage } from "../src/client/types";
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

const completed = 1794133393000;
const exactTime = (record: NativeDisplayRecord, time = completed) => ({
  ...record,
  event: { ...record.event, response_completed_at_ms: time },
});

test("canonical response time accepts only positive JavaScript Date integers and only on Assistant DTOs", () => {
  const bad = [
    undefined,
    null,
    -1,
    0,
    1.5,
    "100",
    NaN,
    Infinity,
    8_640_000_000_000_001,
  ];
  for (const time of [...bad, 1, completed, 8_640_000_000_000_000]) {
    const extra = { response_completed_at_ms: time };
    const native = message("answer", "assistant", "answer", {
      ...extra,
      tool_calls: [{ id: "read", name: "read", arguments: {} }],
    });
    const projected = applySnapshot(
      snapshot([
        message("prompt", "user", "question", extra),
        native,
        message("result", "tool", "result", extra),
      ]),
    );
    for (const block of projected.blocks) {
      const admitted = block.role === "assistant";
      expect(block.responseAdmission).toBe(admitted ? "admitted" : undefined);
      expect(block.responseCompletedAtMs).toBe(
        admitted && !bad.includes(time) ? time : undefined,
      );
      expect(block.startedMs).toBeUndefined();
      expect(block.endedMs).toBeUndefined();
    }
  }
});

test("delayed overlapping pages cannot rewrite an exact canonical certificate", () => {
  const accepted = message("a", "assistant", "answer", {
    response_completed_at_ms: completed,
  });
  const loaded = snapshot([accepted]);
  const page = (row: NativeMessage) => ({
    items: [row],
    truncated: false,
    next_cursor: null,
    history_view: loaded.history_view,
  });
  for (const time of [42, undefined]) {
    const merged = mergeHistoryPage(
      loaded,
      page({ ...accepted, response_completed_at_ms: time }),
    );
    expect(merged?.messages[0].response_completed_at_ms).toBe(completed);
  }
  const sibling = {
    ...accepted,
    canonical_source_id: "sibling",
    response_completed_at_ms: undefined,
  };
  expect(
    mergeHistoryPage(loaded, page(sibling))?.messages[0]
      .response_completed_at_ms,
  ).toBeUndefined();
  const reset = snapshot([
    { ...accepted, response_completed_at_ms: undefined },
  ]);
  reset.history_view!.lineage = "new";
  expect(
    retainLoadedMessages(reset, loaded).messages[0].response_completed_at_ms,
  ).toBeUndefined();
});

test("live and replay bind reasoning, text and call fragments only to their exact admitted attempt", () => {
  const accepted = message("answer", "assistant", "answer", {
    tool_calls: [{ id: "tool", name: "read", arguments: {} }],
  });
  const records = [
    exactTime(chunk(1, "reasoning", null, "reasoning", "thought"), 7),
    chunk(2, "text", "reasoning", "text", "answer"),
    chunk(3, "call", "text", "tool_call", "{}"),
    exactTime(terminal(4, 7, 6), 8),
  ];
  let t = graphTranscript();
  for (const record of records) emit(t, record);
  expect(graphRows(t).map((row) => row.responseAdmission)).toEqual([
    "preview",
    "preview",
    "preview",
  ]);
  expect(
    graphRows(t).every((row) => row.responseCompletedAtMs === undefined),
  ).toBe(true);
  const admit = exactTime(binding(5, ["reasoning", "text", "call"], accepted));
  // Conflicting producer envelope is not allowed to certify the response.
  emit(t, { ...admit, sequence: 8, attempt_id: "other" });
  expect(
    graphRows(t).every((row) => row.responseCompletedAtMs === undefined),
  ).toBe(true);
  emit(t, admit);
  emit(t, { ...exactTime(admit, 77), sequence: 9 });
  emit(t, exactTime(binding(10, ["text"], accepted, "fake"), 78));
  expect(
    graphRows(t).map((row) => [
      row.responseAdmission,
      row.responseCompletedAtMs,
    ]),
  ).toEqual([
    ["admitted", completed],
    ["admitted", completed],
    ["admitted", completed],
  ]);
  // A resumed page may deliver the archival binding before the visible chunks.
  const replay = graphTranscript();
  replayDisplayObservations(replay, "s1", [
    admit,
    ...records.slice().reverse(),
    admit,
  ]);
  expect(graphRows(replay).map((row) => row.responseCompletedAtMs)).toEqual([
    completed,
    completed,
    completed,
  ]);
  t = applySnapshot(snapshot([accepted]), t);
  expect(graphRows(t).map((row) => row.responseCompletedAtMs)).toEqual([
    completed,
    completed,
    completed,
  ]);
  const replacement = { ...accepted, canonical_source_id: "other-source" };
  const changed = snapshot([replacement]);
  changed.history_view!.lineage = "new-history";
  const reset = applySnapshot(changed, t);
  expect(
    reset.blocks.every((row) => row.responseCompletedAtMs === undefined),
  ).toBe(true);
  const same = snapshot([accepted]);
  same.history_view!.lineage = "new-history";
  expect(
    applySnapshot(same, t).blocks.every(
      (row) => row.responseCompletedAtMs === undefined,
    ),
  ).toBe(true);
  same.messages = [{ ...accepted, response_completed_at_ms: completed }];
  expect(
    applySnapshot(same, t).blocks.every(
      (row) => row.responseCompletedAtMs === completed,
    ),
  ).toBe(true);
});

test("canonical-only admission and verified fork remap never borrow source execution or stale clocks", () => {
  const accepted = message("answer", "assistant", "non-streaming");
  const archived = canonical(1, "canonical", null, accepted);
  archived.attempt_id = "attempt";
  (archived.event.display_block as { attempt_id: string }).attempt_id =
    "attempt";
  const t = graphTranscript();
  emit(t, archived);
  expect(graphRows(t)[0].responseAdmission).toBe("admitted");
  expect(graphRows(t)[0].responseCompletedAtMs).toBeUndefined();
  const admission = exactTime(binding(2, [], accepted));
  emit(t, admission);
  expect(graphRows(t)[0].responseCompletedAtMs).toBe(completed);
  const remap = (
    sequence: number,
    row: NativeMessage,
  ): NativeDisplayRecord => ({
    sequence,
    attempt_id: "fork",
    event: {
      ...producer,
      phase: "display_fork_remap",
      source_session_id: "source",
      target_session_id: "s1",
      mappings: [
        {
          canonical_source_id: accepted.canonical_source_id,
          source_canonical_message_id: accepted.id,
          canonical_message_id: row.id,
          message: row,
        },
      ],
    },
  });
  const fork = graphTranscript();
  emit(fork, archived);
  emit(fork, binding(2, [], accepted)); // Server strips time from source bindings on target replay.
  const destination = { ...accepted, id: "destination" };
  emit(fork, remap(3, destination));
  expect(graphRows(fork)[0].messageId).toBe(destination.id);
  expect(graphRows(fork)[0].responseCompletedAtMs).toBeUndefined();
  const verified = graphTranscript();
  replayDisplayObservations(verified, "s1", [
    archived,
    binding(2, [], accepted),
    remap(3, { ...destination, response_completed_at_ms: completed }),
  ]);
  emit(verified, remap(4, { ...destination, response_completed_at_ms: 42 }));
  expect(graphRows(verified)[0].responseCompletedAtMs).toBe(completed);
  expect(graphRows(verified)[0].executionId).toBeUndefined();
});
