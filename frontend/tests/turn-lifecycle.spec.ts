import { expect, test } from "@playwright/test";
import { applyEvent, applySnapshot } from "../src/client/projector";
import { observeTurnLifecycle } from "../src/client/turn-lifecycle";
import type { NativeOperation } from "../src/client/types";
import { nativeSnapshot } from "./native-fixture";

function operation(
  id: string,
  status: NativeOperation["status"],
  method = "turn.submit",
): NativeOperation {
  return {
    id,
    status,
    method,
    session_id: "s1",
    version: 1,
    owner: "u1",
    payload_hash: "opaque",
    result: null,
    revision: 1,
    created_at_ms: 1,
    updated_at_ms: 2,
  };
}

test("receipt lifecycle replaces changed owners and never mutates published prior facts", () => {
  const transcript = applySnapshot(structuredClone(nativeSnapshot));
  observeTurnLifecycle(transcript, "s1", operation("A", "accepted"));
  const prior = transcript.turnLifecycle!;
  Object.freeze(prior.operations);
  Object.freeze(prior.activeOperationIds);
  Object.freeze(prior);
  observeTurnLifecycle(transcript, "s1", operation("A", "running"));
  expect(transcript.turnLifecycle).toBe(prior);
  observeTurnLifecycle(transcript, "s1", operation("A", "completed"));
  expect(transcript.turnLifecycle).not.toBe(prior);
  expect(prior.activeOperationIds).toEqual(["A"]);
  expect(prior.operations.A).toBe("active");
  expect(transcript.turnLifecycle!.activeOperationIds).toEqual([]);
  expect(transcript.turnLifecycle!.completionRevision).toBe(
    prior.completionRevision + 1,
  );
});

test("exact active Turns survive omitted receipts, idle metadata and unknown outcome; only their terminals settle", () => {
  const base = structuredClone(nativeSnapshot);
  base.messages = [];
  let transcript = applySnapshot(base);
  observeTurnLifecycle(transcript, "s1", operation("A", "accepted"));
  observeTurnLifecycle(
    transcript,
    "s1",
    operation("B", "running", "turn.inbox"),
  );
  transcript = applySnapshot(base, transcript);
  expect(transcript.turnLifecycle?.activeOperationIds).toEqual(["A", "B"]);
  observeTurnLifecycle(transcript, "s1", operation("A", "unknown"));
  expect(transcript.turnLifecycle?.activeOperationIds).toEqual(["A", "B"]);
  observeTurnLifecycle(transcript, "s1", operation("A", "completed"));
  expect(transcript.turnLifecycle?.activeOperationIds).toEqual(["B"]);
  expect(transcript.turnLifecycle?.completionRevision).toBe(1);
  observeTurnLifecycle(transcript, "s1", operation("A", "completed"));
  observeTurnLifecycle(transcript, "s1", operation("A", "running"));
  expect(transcript.turnLifecycle?.activeOperationIds).toEqual(["B"]);
  expect(transcript.turnLifecycle?.completionRevision).toBe(1);
  base.operations = [operation("B", "interrupted", "turn.inbox")];
  transcript = applySnapshot(base, transcript);
  expect(transcript.turnLifecycle?.activeOperationIds).toEqual([]);
  expect(transcript.turnLifecycle?.completionRevision).toBe(2);
});

test("history/Session replacement cannot inherit active operation evidence", () => {
  const base = structuredClone(nativeSnapshot);
  base.history_view = {
    lineage: "A",
    epoch: 0,
    start_cursor: 0,
    end_cursor: 2,
    message_count: 2,
    turns: [],
  };
  const transcript = applySnapshot(base);
  observeTurnLifecycle(transcript, "s1", operation("A", "running"));
  const replacement = structuredClone(base);
  replacement.history_view!.lineage = "B";
  expect(
    applySnapshot(replacement, transcript).turnLifecycle?.activeOperationIds,
  ).toEqual([]);
  const other = structuredClone(base);
  other.session.id = "s2";
  expect(
    applySnapshot(other, transcript).turnLifecycle?.activeOperationIds,
  ).toEqual([]);
});

for (const method of [
  "turn.submit",
  "turn.retry",
  "turn.inbox",
  "inbox.resume",
]) {
  test(`${method} live receipt and snapshot settlement share one lifecycle authority`, () => {
    const transcript = applySnapshot(structuredClone(nativeSnapshot));
    applyEvent(transcript, {
      v: 1,
      type: "event",
      session_id: "s1",
      subscription_id: "sub",
      generation: "g",
      sequence: 1,
      event: "turn",
      data: operation("A", "running", method),
    });
    expect(transcript.turnLifecycle?.activeOperationIds).toEqual(["A"]);
    const snapshot = structuredClone(nativeSnapshot);
    snapshot.operations = [
      operation("A", "completed", method),
      operation("historical", "completed"),
    ];
    const settled = applySnapshot(snapshot, transcript);
    expect(settled.turnLifecycle?.activeOperationIds).toEqual([]);
    expect(settled.turnLifecycle?.completionRevision).toBe(1);
    expect(
      applySnapshot(snapshot, settled).turnLifecycle?.completionRevision,
    ).toBe(1);
    expect(transcript.turnLifecycle?.activeOperationIds).toEqual(["A"]);
  });
}

test("queue admission and unrelated owners never claim foreground activity", () => {
  const transcript = applySnapshot(structuredClone(nativeSnapshot));
  for (const method of [
    "turn.queue",
    "turn.steer",
    "session.auto_rename",
    "inbox.update",
  ])
    observeTurnLifecycle(
      transcript,
      "s1",
      operation(method, "running", method),
    );
  observeTurnLifecycle(transcript, "s1", {
    ...operation("other", "running"),
    session_id: "s2",
  });
  expect(transcript.turnLifecycle?.activeOperationIds).toEqual([]);
});
