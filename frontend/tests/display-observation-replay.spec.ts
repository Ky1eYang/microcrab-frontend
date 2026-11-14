import { DisplayFragments } from "../src/client/display-replay";
import { expect, test } from "@playwright/test";
import {
  applySnapshot,
  applyEvent,
  replayDisplayObservations,
} from "../src/client/projector";
import { childTranscript } from "../src/features/childTranscript";
import type {
  NativeChildDetail,
  NativeDisplayRecord,
  NativeSnapshot,
} from "../src/client/types";
import { nativeBackend, nativeSnapshot } from "./native-fixture";

const identity = {
  call_id: "durable-call",
  operation_id: "durable-operation",
  epoch: 0,
  turn: 1,
  round: 1,
};
const record = (
  sequence: number,
  phase: string,
  text = "",
): NativeDisplayRecord => ({
  sequence,
  attempt_id: "durable-attempt",
  event: { ...identity, phase, text },
});
function snapshot(lineage = "archive-A", id = "s1"): NativeSnapshot {
  const value = structuredClone(nativeSnapshot);
  value.session.id = id;
  value.messages[0].position = { epoch: 0, turn: 1, round: 0 };
  value.messages[1].position = { epoch: 0, turn: 1, round: 1 };
  value.history_view = {
    lineage,
    epoch: 0,
    start_cursor: 0,
    end_cursor: 2,
    message_count: 2,
    turns: [],
  };
  return value;
}

test("archive replay orders overlapping live/replayed UTF-8 chunks without duplicating canonical answer or request facts", () => {
  const source = snapshot();
  const before = JSON.stringify(source);
  const transcript = applySnapshot(source);
  const text = "思考完整正文".repeat(20000) + "COMPLETE_UTF8_TAIL";
  const records = [
    record(1, "started"),
    record(2, "reasoning_delta", text.slice(0, 50000)),
    record(3, "reasoning_delta", text.slice(50000)),
    record(4, "validated", "Not a replacement canonical answer"),
  ];
  applyEvent(transcript, {
    v: 1,
    type: "event",
    subscription_id: "s",
    generation: "g",
    sequence: 1,
    session_id: "s1",
    event: "model_observation",
    data: {
      ...records[2].event,
      archive_sequence: 3,
      attempt_id: "durable-attempt",
    },
  });
  replayDisplayObservations(transcript, "s1", records);
  replayDisplayObservations(transcript, "s1", records);
  expect(
    transcript.blocks
      .filter((block) => block.kind === "reasoning")
      .map((block) => ({ text: block.payload.text, stream: block.stream })),
  ).toEqual([{ text, stream: "complete" }]);
  expect(
    transcript.blocks
      .filter((block) => block.kind === "text")
      .map((block) => block.payload.text),
  ).toEqual(source.messages.map((message) => message.text));
  expect(JSON.stringify(source)).toBe(before);
  const refreshed = applySnapshot(source, transcript);
  expect(
    refreshed.blocks
      .filter((block) => block.kind === "reasoning")
      .map((block) => block.payload.text),
  ).toEqual([text]);
});

test("a validated suffix remains incomplete until missing UTF-8 prefix is replayed", () => {
  const transcript = applySnapshot(snapshot());
  const prefix = "前缀";
  const suffix = "正文";
  replayDisplayObservations(transcript, "s1", [
    {
      ...record(3, "reasoning_delta", suffix),
      event: {
        ...record(3, "reasoning_delta", suffix).event,
        stream_offset: 6,
      },
    },
    {
      ...record(4, "validated"),
      event: { ...record(4, "validated").event, reasoning_bytes: 12 },
    },
  ]);
  expect(
    transcript.blocks.find((block) => block.kind === "reasoning")?.stream,
  ).toBe("stopped");
  replayDisplayObservations(transcript, "s1", [
    {
      ...record(2, "reasoning_delta", prefix),
      event: {
        ...record(2, "reasoning_delta", prefix).event,
        stream_offset: 0,
      },
    },
  ]);
  const block = transcript.blocks.find((item) => item.kind === "reasoning")!;
  expect(block.stream).toBe("complete");
  expect(block.payload.text).toBe(prefix + suffix);
});

test("same positions on a sibling or another Session never borrow archived reasoning", () => {
  const original = applySnapshot(snapshot());
  replayDisplayObservations(original, "s1", [
    record(1, "reasoning_delta", "PRIVATE_BRANCH_A"),
    record(2, "invalidated"),
  ]);
  expect(
    original.blocks.find((block) => block.kind === "reasoning")?.stream,
  ).toBe("stopped");
  const sibling = applySnapshot(snapshot("archive-sibling"), original);
  expect(sibling.blocks.some((block) => block.kind === "reasoning")).toBe(
    false,
  );
  const other = applySnapshot(snapshot("archive-B", "s2"), original);
  expect(other.blocks.some((block) => block.kind === "reasoning")).toBe(false);
});

test("authorized child records restore under child identity and retain parent request-audit scope", () => {
  const child: NativeChildDetail = {
    id: "child-1",
    name: "worker",
    status: "completed",
    availability: "persisted",
    parent_session_id: "s1",
    messages: snapshot().messages,
    history_view: snapshot("child-lineage").history_view,
    next_cursor: null,
    messages_truncated: false,
    receipt: null,
    usage: null,
    executions: [],
    history: null,
    display_records: [
      record(1, "reasoning_delta", "CHILD_ONLY"),
      record(2, "validated"),
    ].map((item) => ({
      ...item,
      event: { ...item.event, subagent: "child-1" },
    })),
  };
  const original = JSON.stringify(child.messages);
  const transcript = childTranscript(child);
  const thought = transcript.blocks.find(
    (block) => block.kind === "reasoning",
  )!;
  expect(thought.payload.text).toBe("CHILD_ONLY");
  expect(thought.sessionId).toBe("child-1");
  expect(thought.payload.auditScope).toEqual({
    parentId: "s1",
    childId: "child-1",
  });
  expect(JSON.stringify(child.messages)).toBe(original);
});

test("unavailable archive is visible while canonical answer remains readable", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  Object.assign(backend.snapshot(), snapshot(), {
    display: { high_water: 0, coverage: "unavailable" },
  });
  await page.goto("/#session/s1");
  await expect(page.getByTestId("conversation-display-coverage")).toContainText(
    "思考记录暂不可用",
  );
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
});

test("filtered catchup certifies gaps while an out-of-order live suffix waits for its prefix", () => {
  const transcript = applySnapshot(snapshot());
  replayDisplayObservations(transcript, "s1", [
    record(12, "reasoning_delta", "suffix"),
  ]);
  expect(transcript.displayReplay?.watermark).toBe(0);
  applyEvent(transcript, {
    v: 1,
    type: "event",
    subscription_id: "s",
    generation: "g",
    sequence: 1,
    session_id: "s1",
    event: "display.batch",
    data: {
      after: 0,
      scanned_through: 11,
      high_water: 13,
      next_cursor: 11,
      history_lineage: "archive-A",
      coverage: "available",
      records: [],
    },
  });
  expect(transcript.displayReplay?.watermark).toBe(12);
  applyEvent(transcript, {
    v: 1,
    type: "event",
    subscription_id: "s",
    generation: "g",
    sequence: 2,
    session_id: "s1",
    event: "display.settled",
    data: {
      after: 11,
      scanned_through: 13,
      high_water: 13,
      next_cursor: null,
      history_lineage: "archive-A",
      coverage: "available",
      records: [record(13, "validated")],
    },
  });
  expect(transcript.displayReplay?.watermark).toBe(13);
  const sibling = applySnapshot(snapshot("sibling"), transcript);
  expect(sibling.displayReplay).toBeUndefined();
});

test("pushed thinking survives refresh in place and resumes from certified watermark without HTTP hydration", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  Object.assign(backend.snapshot(), snapshot(), {
    display: { high_water: 4, coverage: "available" },
  });
  let reads = 0;
  await page.route("**/display/observations/query", async (route) => {
    reads++;
    await route.abort();
  });
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  backend.event("display.settled", {
    after: 0,
    scanned_through: 4,
    high_water: 4,
    next_cursor: null,
    history_lineage: "archive-A",
    coverage: "available",
    records: [
      record(2, "reasoning_delta", "PUSHED_THOUGHT"),
      record(4, "validated"),
    ],
  });
  const thought = page.getByTestId("think-block");
  await expect(thought).toHaveCount(1);
  await thought.evaluate((node) => {
    (window as any).__pushThought = node;
  });
  backend.event("turn", {
    version: 1,
    id: "done",
    session_id: "s1",
    owner: "owner",
    method: "turn.submit",
    payload_hash: "hash",
    status: "completed",
    result: {},
    revision: 1,
    created_at_ms: 1,
    updated_at_ms: 2,
  });
  // A terminal receipt preserves the existing subscription. Only a recovery
  // signal reopens it, carrying the certified archive watermark and lineage.
  expect(backend.sessionSockets).toHaveLength(1);
  backend.event("resync_required", { reason: "slow_consumer" });
  await expect.poll(() => backend.sessionSockets.length).toBeGreaterThan(1);
  const resubscribed = new URL(backend.sessionSockets.at(-1)!.url());
  expect(resubscribed.searchParams.get("display_watermark")).toBe("4");
  expect(resubscribed.searchParams.get("history_lineage")).toBe("archive-A");
  expect(
    await thought.evaluate((node) => node === (window as any).__pushThought),
  ).toBe(true);
  expect(reads).toBe(0);
});

test("oversized display pages commit atomically and partial bytes cannot cross subscriptions", () => {
  const fragments = new DisplayFragments();
  const page = {
    after: 0,
    scanned_through: 2,
    high_water: 2,
    next_cursor: null,
    history_lineage: "archive-A",
    child_session_id: null,
    coverage: "available",
    records: [
      record(1, "reasoning_delta", "界🦀".repeat(200000)),
      record(2, "validated"),
    ],
  };
  const body = JSON.stringify(page),
    split = Math.floor(body.length / 2);
  const event = (index: number, text: string, subscription = "s") => ({
    v: 1 as const,
    type: "event" as const,
    subscription_id: subscription,
    generation: "g",
    sequence: index + 1,
    session_id: "s1",
    event: "display.fragment",
    data: {
      id: "page",
      index,
      text,
      last: index === 1,
      event: "display.settled",
      history_lineage: "archive-A",
      child_session_id: null,
    },
  });
  expect(fragments.receive(event(0, body.slice(0, split)))).toBeNull();
  expect(
    fragments.receive(event(1, body.slice(split), "replacement")),
  ).toBeNull();
  expect(
    fragments.receive(event(0, body.slice(0, split), "replacement")),
  ).toBeNull();
  const assembled = fragments.receive(
    event(1, body.slice(split), "replacement"),
  )!;
  const transcript = applySnapshot(snapshot());
  applyEvent(transcript, assembled);
  expect(transcript.displayReplay?.watermark).toBe(2);
  expect(
    transcript.blocks.find((block) => block.kind === "reasoning")?.payload.text,
  ).toBe(page.records[0].event.text);
});

test("disconnect during partial display catchup reconnects from received watermark rather than available high water", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  Object.assign(backend.snapshot(), snapshot(), {
    display: { high_water: 20, coverage: "available" },
  });
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  backend.event("display.batch", {
    after: 0,
    scanned_through: 4,
    high_water: 20,
    next_cursor: 4,
    history_lineage: "archive-A",
    coverage: "available",
    records: [record(2, "reasoning_delta", "RECEIVED_PARTIAL_THOUGHT")],
  });
  await expect(page.getByTestId("think-block")).toHaveCount(1);
  const before = backend.sessionSockets.length;
  backend.sessionSockets
    .at(-1)!
    .close({ code: 1012, reason: "catchup interrupted" });
  await expect.poll(() => backend.sessionSockets.length).toBe(before + 1);
  const url = new URL(backend.sessionSockets.at(-1)!.url());
  expect(url.searchParams.get("display_watermark")).toBe("4");
  expect(url.searchParams.get("history_lineage")).toBe("archive-A");
  expect(url.searchParams.has("after_message_id")).toBe(false);
  expect(
    backend.commands.filter((command) => command.method === "session.blocks"),
  ).toHaveLength(0);
});
