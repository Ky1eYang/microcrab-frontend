import { expect, test } from "@playwright/test";
import {
  applyEvent,
  applySnapshot,
  createBlock,
} from "../src/client/projector";
import type { NativeOperation, Transcript } from "../src/client/types";
import { canonical, emit, message, snapshot } from "./display-graph-inputs";

function preview(
  transcript: Transcript,
  operationId: string,
  text = "original",
) {
  const block = createBlock(
    "s1",
    `preview:${operationId}`,
    "text",
    "text",
    "user",
  );
  Object.assign(block, {
    temporary: true,
    operationId,
    submissionStatus: "submitting",
  });
  block.payload.text = text;
  transcript.blocks.push(block);
  return block;
}
function receipt(
  status: NativeOperation["status"] = "completed",
): NativeOperation {
  return {
    version: 1,
    id: "send",
    session_id: "s1",
    owner: "owner",
    method: "turn.queue",
    payload_hash: "opaque",
    status,
    result: { admitted: true },
    revision: 1,
    created_at_ms: 1,
    updated_at_ms: 2,
  };
}
const users = (transcript: Transcript) =>
  transcript.blocks.filter((block) => block.role === "user");

test("receipt-first queue completion keeps its immediate preview admitted and waiting", () => {
  let transcript = applySnapshot(snapshot());
  preview(transcript, "send");
  applyEvent(transcript, {
    v: 1,
    type: "event",
    event: "turn",
    session_id: "s1",
    subscription_id: "sub",
    generation: "g",
    sequence: 1,
    data: receipt(),
  });
  expect(users(transcript)).toHaveLength(1);
  expect(users(transcript)[0]).toMatchObject({
    temporary: true,
    submissionStatus: "admitted",
  });
  expect(transcript.turnLifecycle?.activeOperationIds ?? []).toEqual([]);
  const waiting = snapshot();
  waiting.operations = [receipt()];
  transcript = applySnapshot(waiting, transcript);
  expect(users(transcript)).toHaveLength(1);
  expect(users(transcript)[0].temporary).toBe(true);
});

for (const content of ["transformed by plugin", ""]) {
  test(`graph-first exact admission hands off ${content ? "transformed text" : "image-only input"} before delayed canonical page`, () => {
    let transcript = applySnapshot(snapshot());
    preview(transcript, "send", content ? "original" : "");
    const actual = message("actual", "user", content, {
      submission_operation_id: "send",
      position: null,
      parts: content
        ? []
        : [
            {
              type: "image",
              source: { type: "url", url: "https://example.test/image.png" },
            },
          ],
    });
    emit(transcript, canonical(1, "actual-node", null, actual));
    expect(users(transcript)).toHaveLength(1);
    expect(users(transcript)[0]).toMatchObject({
      id: "actual-node",
      operationId: "send",
    });
    expect(users(transcript)[0].temporary).toBeFalsy();
    expect(users(transcript)[0].payload.text).toBe(content);
    const bounded = snapshot([]);
    bounded.messages_truncated = true;
    transcript = applySnapshot(bounded, transcript);
    expect(users(transcript)).toHaveLength(1);
    expect(users(transcript)[0].position).toBeNull();
    const positioned = { ...actual, position: { epoch: 0, turn: 1, round: 1 } };
    transcript = applySnapshot(snapshot([positioned]), transcript);
    expect(users(transcript)).toHaveLength(1);
    expect(users(transcript)[0].id).toBe("actual-node");
    expect(users(transcript)[0].position).toEqual(positioned.position);
  });
}

test("canonical-first identity preserves repeated canonical inputs and only consumes its own preview", () => {
  const first = message("first", "user", "same", {
    submission_operation_id: "first-send",
  });
  let transcript = applySnapshot(snapshot([first]));
  preview(transcript, "send", "same");
  preview(transcript, "next-send", "same");
  const second = message("second", "user", "same", {
    submission_operation_id: "send",
  });
  const before = JSON.stringify(transcript);
  transcript = applySnapshot(snapshot([first, second]), transcript);
  expect(users(transcript).map((block) => block.messageId)).toEqual([
    "first",
    "second",
    "preview:next-send",
  ]);
  expect(JSON.parse(before).blocks).toHaveLength(3);
  emit(transcript, canonical(1, "first-node", null, first));
  emit(transcript, canonical(2, "second-node", "first-node", second));
  expect(users(transcript).map((block) => block.messageId)).toEqual([
    "first",
    "second",
    "preview:next-send",
  ]);
});

test("equal text, failed or unknown receipts and child certificates cannot claim an unlinked preview", () => {
  for (const status of ["failed", "unknown", "completed"] as const) {
    let transcript = applySnapshot(snapshot());
    preview(transcript, "send", "same");
    const view = snapshot([message("unlinked", "user", "same")]);
    view.operations = [receipt(status)];
    transcript = applySnapshot(view, transcript);
    expect(users(transcript).map((block) => block.messageId)).toEqual([
      "unlinked",
      "preview:send",
    ]);
  }
  const main = applySnapshot(snapshot());
  preview(main, "send");
  const childView = snapshot([
    message("child-user", "user", "original", {
      submission_operation_id: "send",
    }),
  ]);
  childView.session.id = "child";
  const child = applySnapshot(childView);
  expect(users(main)[0].temporary).toBe(true);
  expect(users(child)).toHaveLength(1);
  expect(users(child)[0].sessionId).toBe("child");
});

test("snapshot projection preserves explicit presentation reset revision across ordinary epoch hydration", () => {
  const prior = applySnapshot(snapshot());
  prior.historyResetRevision = 4;
  const view = snapshot();
  view.history_view!.epoch = 2;
  expect(applySnapshot(view, prior).historyResetRevision).toBe(4);
});
