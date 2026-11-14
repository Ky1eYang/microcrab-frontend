import { expect, test } from "@playwright/test";
import {
  applyEvent,
  applySnapshot,
  projectRetryReceipt,
} from "../src/client/projector";
import type { NativeOperation, NativeSnapshot } from "../src/client/types";
import { nativeBackend, nativeSnapshot } from "./native-fixture";

const failure: NativeOperation = {
  version: 1,
  id: "failed-original",
  session_id: "s1",
  owner: "u1",
  method: "turn.submit",
  payload_hash: "fixture",
  status: "failed",
  result: {
    error: { code: "provider_timeout", message: "Model request timed out" },
    after_message_id: "u1",
    position: { epoch: 0, turn: 1, round: 1 },
    retry_ready: true,
    partial_output: {
      call_id: "failed-call",
      epoch: 0,
      turn: 1,
      round: 1,
      text: "Failed partial",
      reasoning: "Failed thinking",
    },
  },
  revision: 1,
  created_at_ms: 1,
  updated_at_ms: 2,
};
const snapshot: NativeSnapshot = {
  ...nativeSnapshot,
  session: {
    ...nativeSnapshot.session,
    retry_ready: true,
    retry_operation_id: failure.id,
  },
  history: { checkpoint_id: "selected-failure" },
  messages: [
    { id: "u1", role: "user", text: "Prompt", parts: [], tool_calls: [] },
  ],
  operations: [failure],
};
const retry: NativeOperation = {
  ...failure,
  id: "retry-current",
  method: "turn.retry",
  status: "accepted",
  created_at_ms: 3,
  updated_at_ms: 3,
  result: {
    retry_of_operation_id: failure.id,
    retry_after_message_id: "u1",
  },
};
const errors = (transcript: ReturnType<typeof applySnapshot>) =>
  transcript.blocks
    .filter((block) => block.stream === "error")
    .map((block) => block.operationId);

test("authoritative retry admission supersedes only its exact failed operation", () => {
  const unrelated = { ...failure, id: "unrelated-failure" };
  const prior = applySnapshot({
    ...snapshot,
    operations: [failure, unrelated],
  });
  const before = structuredClone(prior);
  expect(projectRetryReceipt(prior, { ...retry, status: "unknown" })).toBe(
    false,
  );
  expect(errors(prior)).toEqual([failure.id, unrelated.id]);
  expect(projectRetryReceipt(prior, retry)).toBe(true);
  expect(prior.sessionStatus).toBe("busy");
  expect(errors(prior)).toEqual([unrelated.id]);
  const admitted = {
    ...snapshot,
    session: { ...snapshot.session, status: "running" },
    operations: [failure, unrelated, retry],
  };
  expect(errors(applySnapshot(admitted, before))).toEqual([unrelated.id]);
  expect(errors(applySnapshot(admitted))).toEqual([unrelated.id]);
  expect(errors(before)).toEqual([failure.id, unrelated.id]);
  const legacy = applySnapshot(snapshot);
  delete legacy.blocks.find((block) => block.stream === "error")!.operationId;
  expect(projectRetryReceipt(legacy, retry)).toBe(true);
  expect(legacy.blocks.some((block) => block.stream === "error")).toBe(false);
  const retainedLegacy = applySnapshot(snapshot);
  delete retainedLegacy.blocks.find((block) => block.stream === "error")!
    .operationId;
  expect(errors(applySnapshot(admitted, retainedLegacy))).toEqual([
    unrelated.id,
  ]);
});

test("selected-branch supersession survives bounded receipt pages without erasing unrelated legacy failures", () => {
  const unrelated = { ...failure, id: "unrelated-failure" };
  const prior = applySnapshot({
    ...snapshot,
    operations: [failure, unrelated],
  });
  const bounded = {
    ...snapshot,
    operations: [failure, unrelated],
    operations_truncated: true,
    superseded_failure_operation_ids: [failure.id],
  };
  const projected = applySnapshot(bounded, prior);
  expect(errors(projected)).toEqual([unrelated.id]);
  expect(errors(applySnapshot(bounded))).toEqual([unrelated.id]);
  expect(
    errors(
      applySnapshot({ ...snapshot, operations: [failure, unrelated] }, prior),
    ),
  ).toEqual([failure.id, unrelated.id]);
  // The authoritative set belongs to this snapshot, not a browser tombstone.
  expect(
    errors(
      applySnapshot(
        { ...snapshot, operations: [failure, unrelated] },
        projected,
      ),
    ),
  ).toEqual([failure.id, unrelated.id]);
});

test("failed retry replaces one linked failure and preserves unrelated later failures through refresh and reload", () => {
  const secondFailure = {
    ...retry,
    status: "failed" as const,
    updated_at_ms: 4,
    result: {
      ...(retry.result as object),
      ...(failure.result as object),
    },
  };
  const laterFailure = {
    ...failure,
    id: "later-failure",
    created_at_ms: 5,
    updated_at_ms: 6,
    result: { ...(failure.result as object), after_message_id: "u2" },
  };
  let transcript = applySnapshot(snapshot);
  applyEvent(transcript, {
    v: 1,
    type: "event",
    subscription_id: "sub",
    generation: "g",
    sequence: 1,
    session_id: "s1",
    event: "turn",
    data: secondFailure,
  });
  expect(errors(transcript)).toEqual([retry.id]);
  const later = {
    ...snapshot,
    operations: [laterFailure, secondFailure, failure],
    messages: [
      ...snapshot.messages,
      {
        id: "u2",
        role: "user" as const,
        text: "Later",
        parts: [],
        tool_calls: [],
      },
    ],
  };
  transcript = applySnapshot(later, transcript);
  transcript = applySnapshot(later, transcript);
  expect(errors(transcript)).toEqual([retry.id, laterFailure.id]);
  expect(errors(applySnapshot(later))).toEqual([retry.id, laterFailure.id]);
  // A different selected branch cannot inherit either observed failure.
  expect(
    errors(
      applySnapshot(
        {
          ...snapshot,
          messages: [{ ...snapshot.messages[0], id: "other-branch-user" }],
          operations: [],
        },
        transcript,
      ),
    ),
  ).toEqual([]);
});

test("retry linkage cannot cross sessions or absent branch witnesses, and failed admission restores original feedback", () => {
  for (const invalid of [
    { ...retry, session_id: "other-session" },
    {
      ...retry,
      result: {
        ...(retry.result as object),
        retry_after_message_id: "other-branch",
      },
    },
    {
      ...retry,
      status: "failed" as const,
      result: { error: { message: "Not started" } },
    },
  ]) {
    const transcript = applySnapshot(snapshot);
    expect(projectRetryReceipt(transcript, invalid)).toBe(false);
    expect(errors(transcript)).toEqual([failure.id]);
    expect(
      errors(applySnapshot({ ...snapshot, operations: [failure, invalid] })),
    ).toContain(failure.id);
  }
  const transcript = applySnapshot(snapshot);
  projectRetryReceipt(transcript, retry);
  expect(errors(transcript)).toEqual([]);
  expect(errors(applySnapshot(snapshot, transcript))).toEqual([failure.id]);
});

for (const outcome of [
  "accepted",
  "unknown",
  "rejected",
  "stale-branch",
  "lost-receipt",
] as const) {
  test(`retry ${outcome} preserves failure until authoritative admission and respects its branch`, async ({
    page,
  }) => {
    await nativeBackend(page);
    await page.goto("/");
    const result = await page.evaluate(
      async ({ snapshot, retry, outcome }) => {
        const { AppStore } = await import("/src/state/store.ts");
        const { CommandError } = await import("/src/client/api.ts");
        const store: any = new AppStore();
        store.update({
          sessionId: "s1",
          connection: "ws",
          authSession: { authenticated: true },
          capabilities: { methods: ["turn.retry", "turn.get"] },
        });
        store.subscription = { snapshot };
        store.snapshot(snapshot);
        let resolve!: (receipt: unknown) => void;
        let reject!: (error: Error) => void;
        let operationId = "";
        const calls: string[] = [];
        store.api.request = (method: string, params: any) => {
          calls.push(method);
          operationId = params.operation_id;
          if (method === "turn.get")
            return Promise.resolve({ ...retry, id: operationId });
          return new Promise((yes, no) => {
            resolve = yes;
            reject = no;
          });
        };
        const read = () => ({
          errors: store.state.transcript.blocks
            .filter((block: any) => block.stream === "error")
            .map((block: any) => block.operationId),
          status: store.state.transcript.sessionStatus,
          partials: store.state.transcript.blocks
            .filter(
              (block: any) =>
                block.preview && !block.preview.canonicalMessageId,
            )
            .map((block: any) => block.payload.text),
        });
        const pending = store.dispatch({
          type: "RetryTurn",
          value: "failed-original",
        });
        const during = read();
        if (outcome === "stale-branch")
          store.update({ history: { checkpoint_id: "other-branch" } });
        if (outcome === "rejected") reject(new Error("Retry rejected"));
        else if (outcome === "lost-receipt")
          reject(
            new CommandError("connection_lost", "Receipt lost", false, true),
          );
        else
          resolve({
            ...retry,
            id: operationId,
            status: outcome === "unknown" ? "unknown" : "accepted",
          });
        await pending;
        const after = read();
        store.stop();
        return { during, after, calls };
      },
      { snapshot, retry, outcome },
    );
    expect(result.during.errors).toEqual([failure.id]);
    expect(result.during.partials).toEqual([
      "Failed thinking",
      "Failed partial",
    ]);
    const accepted = outcome === "accepted" || outcome === "lost-receipt";
    expect(result.after.errors).toEqual(accepted ? [] : [failure.id]);
    expect(result.after.status).toBe(accepted ? "busy" : "idle");
    expect(result.after.partials).toEqual(
      accepted ? [] : ["Failed thinking", "Failed partial"],
    );
    expect(result.calls).toEqual(
      outcome === "lost-receipt" ? ["turn.retry", "turn.get"] : ["turn.retry"],
    );
  });
}

test("paged-out origin restores only selected failed scope and admitted retry preserves accepted Context", () => {
  const accepted = {
    id: "accepted-boundary",
    role: "assistant" as const,
    text: "Accepted Context",
    parts: [],
    tool_calls: [],
    position: { epoch: 0, turn: 1, round: 1 },
  };
  const failed = {
    ...failure,
    result: {
      ...(failure.result as object),
      after_message_id: accepted.id,
      position: { epoch: 0, turn: 1, round: 2 },
      partial_output: {
        call_id: "failed-call",
        epoch: 0,
        turn: 1,
        round: 2,
        text: "Unadmitted suffix",
        reasoning: "Unadmitted reasoning",
      },
    },
  };
  const paged = {
    ...snapshot,
    messages_truncated: true,
    messages: [accepted],
    operations: [failed],
  };
  const restored = applySnapshot(paged);
  expect(
    restored.blocks.map((block) => block.payload.text).slice(0, 3),
  ).toEqual(["Accepted Context", "Unadmitted reasoning", "Unadmitted suffix"]);
  expect(
    restored.blocks
      .filter((block) => block.preview)
      .every(
        (block) =>
          block.stream === "stopped" && !block.preview?.canonicalMessageId,
      ),
  ).toBe(true);
  expect(
    applySnapshot(paged, restored).blocks.map((block) => block.id),
  ).toEqual(restored.blocks.map((block) => block.id));
  const admitted = {
    ...retry,
    result: {
      retry_of_operation_id: failed.id,
      retry_after_message_id: accepted.id,
    },
  };
  expect(projectRetryReceipt(restored, admitted)).toBe(true);
  expect(restored.blocks.map((block) => block.payload.text)).toEqual([
    "Accepted Context",
  ]);
  expect(
    applySnapshot({
      ...paged,
      superseded_failure_operation_ids: [failed.id],
    }).blocks.map((block) => block.payload.text),
  ).toEqual(["Accepted Context"]);
  const outsidePage = {
    ...failed,
    result: { ...(failed.result as object), after_message_id: "outside-page" },
  };
  const ordered = applySnapshot({ ...paged, operations: [outsidePage] });
  expect(ordered.blocks.map((block) => block.payload.text).slice(0, 3)).toEqual(
    ["Accepted Context", "Unadmitted reasoning", "Unadmitted suffix"],
  );
  const otherEpoch = applySnapshot({
    ...paged,
    messages: [
      {
        ...accepted,
        id: "other-branch",
        position: { epoch: 1, turn: 1, round: 1 },
      },
    ],
    operations: [outsidePage],
  });
  expect(otherEpoch.blocks.some((block) => block.preview)).toBe(false);
  expect(
    applySnapshot(
      {
        ...paged,
        operations: [],
        messages: [
          {
            ...accepted,
            id: "other-branch",
            position: { epoch: 1, turn: 1, round: 1 },
          },
        ],
      },
      ordered,
    ).blocks.some((block) => block.preview),
  ).toBe(false);
});

test("bounded durable prefix does not shorten already displayed output on refresh", () => {
  const live = applySnapshot(snapshot);
  const text = live.blocks.find(
    (block) => block.kind === "text" && block.preview,
  )!;
  text.payload.text = "Failed partial with the entire already published suffix";
  const bounded = {
    ...failure,
    result: {
      ...(failure.result as object),
      partial_output: {
        call_id: "failed-call",
        epoch: 0,
        turn: 1,
        round: 1,
        text: "Failed partial",
        truncated: true,
      },
    },
  };
  const refreshed = applySnapshot({ ...snapshot, operations: [bounded] }, live);
  expect(
    refreshed.blocks.find((block) => block.kind === "text" && block.preview)
      ?.payload.text,
  ).toBe(text.payload.text);
  expect(
    refreshed.blocks.find((block) => block.kind === "text" && block.preview)
      ?.preview?.truncated,
  ).not.toBe(true);
  const reloaded = applySnapshot({ ...snapshot, operations: [bounded] });
  expect(
    reloaded.blocks.find((block) => block.preview)?.preview?.truncated,
  ).toBe(true);
});

test("autonomous inbox identity rebinds exact failed call without shortening live output", () => {
  const accepted = {
    id: "accepted-boundary",
    role: "assistant" as const,
    text: "Accepted Context",
    parts: [],
    tool_calls: [],
    position: { epoch: 0, turn: 1, round: 1 },
  };
  const base = {
    ...snapshot,
    messages: [...snapshot.messages, accepted],
    operations: [],
  };
  const live = applySnapshot(base);
  const observation = (phase: string, text: string) => ({
    v: 1 as const,
    type: "event" as const,
    subscription_id: "sub",
    generation: "g",
    sequence: 1,
    session_id: "s1",
    event: "model_observation",
    data: {
      operation_id: "inbox:0:1",
      call_id: "inbox-call",
      epoch: 0,
      turn: 1,
      round: 2,
      phase,
      text,
    },
  });
  applyEvent(live, observation("reasoning_delta", "Full live thinking"));
  applyEvent(
    live,
    observation("text_delta", "Full live output longer than persisted prefix"),
  );
  applyEvent(live, observation("invalidated", ""));
  const originalIds = live.blocks
    .filter((block) => block.preview)
    .map((block) => block.id);
  const failed = {
    ...failure,
    method: "turn.inbox",
    result: {
      ...(failure.result as object),
      after_message_id: accepted.id,
      position: { epoch: 0, turn: 1, round: 2 },
      partial_output: {
        call_id: "inbox-call",
        epoch: 0,
        turn: 1,
        round: 2,
        text: "Full live",
        reasoning: "Full",
        truncated: true,
      },
    },
  };
  const selected = { ...base, operations: [failed] };
  const refreshed = applySnapshot(selected, live);
  const partials = refreshed.blocks.filter((block) => block.preview);
  expect(partials.map((block) => block.id)).toEqual(originalIds);
  expect(partials.map((block) => block.payload.text)).toEqual([
    "Full live thinking",
    "Full live output longer than persisted prefix",
  ]);
  expect(
    partials.every(
      (block) =>
        block.preview?.operationId === failed.id && !block.preview?.truncated,
    ),
  ).toBe(true);
  expect(
    live.blocks
      .filter((block) => block.preview)
      .every((block) => block.preview?.operationId === "inbox:0:1"),
  ).toBe(true);
  expect(
    applySnapshot(selected, refreshed).blocks.map((block) => block.id),
  ).toEqual(refreshed.blocks.map((block) => block.id));
  const unrelated = applySnapshot(
    {
      ...selected,
      operations: [
        {
          ...failed,
          result: {
            ...(failed.result as object),
            partial_output: {
              ...failed.result.partial_output,
              call_id: "different-call",
            },
          },
        },
      ],
    },
    live,
  );
  expect(
    unrelated.blocks.some(
      (block) =>
        block.payload.text === "Full live output longer than persisted prefix",
    ),
  ).toBe(false);
  const admitted = {
    ...retry,
    result: {
      retry_of_operation_id: failed.id,
      retry_after_message_id: accepted.id,
    },
  };
  expect(projectRetryReceipt(refreshed, admitted)).toBe(true);
  expect(refreshed.blocks.map((block) => block.payload.text)).toEqual([
    "Prompt",
    "Accepted Context",
  ]);
  expect(
    applySnapshot(
      { ...selected, superseded_failure_operation_ids: [failed.id] },
      live,
    ).blocks.map((block) => block.payload.text),
  ).toEqual(["Prompt", "Accepted Context"]);
});
