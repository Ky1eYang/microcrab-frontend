import { test, expect } from "@playwright/test";
import { failureText, wireFailure } from "../src/client/failure";
import {
  applyEvent,
  applySnapshot,
  createTranscript,
  dropPreviews,
  subscriptionOrder,
  sessionView,
  createBlock,
  computeTurns,
} from "../src/client/projector";
import type {
  NativeEvent,
  NativeOperation,
  NativeSnapshot,
  NativeSubscription,
} from "../src/client/types";
const snapshot: NativeSnapshot = {
  session: {
    id: "s1",
    title: "Native",
    project_id: "p1",
    status: "idle",
    agent: "coding",
    mode: "plan",
    model: "test",
    created_at_ms: 1,
    updated_at_ms: 2,
    revision: 4,
    archived: false,
  },
  messages: [
    { id: "m1", role: "user", text: "hello", parts: [], tool_calls: [] },
  ],
  permission: {
    revision: 1,
    config: { overrides: [], review: true, initialization: "ask" },
  },
  operations: [],
  history: null,
  usage: null,
};
const event = (phase: string, text?: string): NativeEvent => ({
  v: 1,
  type: "event",
  subscription_id: "sub",
  generation: "g1",
  sequence: 1,
  session_id: "s1",
  event: "model_observation",
  data: { operation_id: "op1", call_id: "call1", phase, text },
});
test("subscription generation and sequence are independent from object revision", () => {
  const subscription: NativeSubscription = {
    subscription_id: "sub",
    generation: "g1",
    sequence: 0,
    snapshot,
  };
  expect(subscriptionOrder(subscription, event("started"))).toBe("next");
  expect(
    subscriptionOrder(subscription, { ...event("started"), sequence: 0 }),
  ).toBe("duplicate");
  expect(
    subscriptionOrder(subscription, { ...event("started"), sequence: 3 }),
  ).toBe("gap");
  expect(
    subscriptionOrder(subscription, { ...event("started"), generation: "g2" }),
  ).toBe("gap");
  expect(
    subscriptionOrder(subscription, {
      ...event("started"),
      subscription_id: "old",
    }),
  ).toBe("other");
  expect(sessionView(snapshot.session).revision).toBe(4);
});

function toolHistory(): NativeSnapshot {
  return {
    ...snapshot,
    messages: [
      {
        id: "call-first",
        role: "assistant",
        text: "",
        parts: [],
        tool_calls: [
          { id: "reused", name: "read", arguments: { path: "seed.txt" } },
        ],
      },
      {
        id: "result-first",
        role: "tool",
        text: "first output",
        parts: [],
        tool_calls: [],
        call_id: "reused",
        tool_name: "read",
      },
      {
        id: "call-second",
        role: "assistant",
        text: "",
        parts: [],
        tool_calls: [
          { id: "reused", name: "read", arguments: { path: "second.txt" } },
        ],
      },
      {
        id: "result-second",
        role: "tool",
        text: "second output",
        parts: [],
        tool_calls: [],
        call_id: "reused",
        tool_name: "read",
      },
      {
        id: "call-unmatched",
        role: "assistant",
        text: "",
        parts: [],
        tool_calls: [
          { id: "reused", name: "read", arguments: { path: "unfinished.txt" } },
        ],
      },
    ],
  };
}

test("canonical tool results retain their own sequential arguments and leave later reused-ID calls visible", () => {
  const transcript = applySnapshot(toolHistory());
  const cards = transcript.blocks.filter((block) => block.kind === "tool");
  expect(cards.map((block) => block.messageId)).toEqual([
    "call-first",
    "call-second",
    "call-unmatched",
  ]);
  expect(cards.map((block) => block.tool?.input)).toEqual([
    { path: "seed.txt" },
    { path: "second.txt" },
    { path: "unfinished.txt" },
  ]);
  expect(cards.map((block) => block.payload.text)).toEqual([
    "first output",
    "second output",
    "",
  ]);
  expect(cards.every((block) => !block.temporary)).toBe(true);
});

test("tool preview with a historical call ID cannot overwrite canonical arguments or output", () => {
  const transcript = applySnapshot(toolHistory());
  const canonicalBefore = structuredClone(transcript.blocks);
  const toolEvent = (
    phase: string,
    extra: Record<string, unknown>,
  ): NativeEvent => ({
    ...event(phase),
    event: "tool",
    data: { call_id: "reused", name: "read", phase, ...extra },
  });
  applyEvent(
    transcript,
    toolEvent("started", { arguments: { path: "preview.txt" } }),
  );
  applyEvent(transcript, toolEvent("result", { result: "temporary output" }));
  expect(transcript.blocks.filter((block) => !block.temporary)).toEqual(
    canonicalBefore,
  );
  const preview = transcript.blocks.filter((block) => block.temporary);
  expect(preview).toHaveLength(1);
  expect(preview[0].tool?.input).toEqual({ path: "preview.txt" });
  expect(preview[0].payload.text).toBe("temporary output");
  dropPreviews(transcript);
  expect(transcript.blocks).toEqual(canonicalBefore);
});

const message = (id: string, role: "user" | "assistant", text: string) => ({
  id,
  role,
  text,
  parts: [],
  tool_calls: [],
});
const observed = (
  turn: number,
  round: number,
  phase: string,
  extra: Record<string, unknown> = {},
): NativeEvent => ({
  ...event(phase),
  data: {
    operation_id: `op${turn}`,
    epoch: 0,
    turn,
    round,
    call_id: "reused-model-id",
    phase,
    ...extra,
  },
});
const turnContents = (t: ReturnType<typeof createTranscript>) =>
  computeTurns(t).map((turn) =>
    turn.rounds.flatMap((round: any) =>
      round.blockIndices.map((index: number) => t.blocks[index].payload.text),
    ),
  );

function submissionReceipt(status: NativeOperation["status"]): NativeOperation {
  return {
    version: 1,
    id: "op1",
    session_id: "s1",
    owner: "owner",
    method: "turn.submit",
    payload_hash: "fixture",
    status,
    result: null,
    revision: 1,
    created_at_ms: 1,
    updated_at_ms: 2,
  };
}
function pendingUser(text = "first prompt") {
  const block = createBlock("s1", "optimistic1", "text", "text", "user");
  block.temporary = true;
  block.operationId = "op1";
  block.payload.text = text;
  return block;
}

test("a bounded page waits for an exact input certificate before retiring its preview", () => {
  let transcript = createTranscript();
  transcript.blocks.push(pendingUser());
  const suffix = [message("a1", "assistant", "large response suffix")];
  transcript = applySnapshot(
    {
      ...snapshot,
      messages: suffix,
      operations: [submissionReceipt("running")],
    },
    transcript,
  );
  expect(
    transcript.blocks.some((block) => block.temporary && block.role === "user"),
  ).toBe(true);
  const prior = transcript;
  const unchanged = JSON.stringify(prior);
  transcript = applySnapshot(
    {
      ...snapshot,
      messages: suffix,
      operations: [submissionReceipt("completed")],
    },
    prior,
  );
  expect(JSON.stringify(prior)).toBe(unchanged);
  expect(transcript.blocks.map((block) => block.messageId)).toEqual([
    "a1",
    "optimistic1",
  ]);
  const later = [
    ...suffix,
    message("u2", "user", "second prompt"),
    message("a2", "assistant", "second response"),
  ];
  transcript = applySnapshot(
    {
      ...snapshot,
      messages: later,
      operations: [submissionReceipt("completed")],
    },
    transcript,
  );
  transcript = applySnapshot(
    {
      ...snapshot,
      messages: [
        {
          ...message("u1", "user", "first prompt"),
          submission_operation_id: "op1",
        },
        ...later,
      ],
      operations: [submissionReceipt("completed")],
    },
    transcript,
  );
  expect(transcript.blocks.map((block) => block.messageId)).toEqual([
    "u1",
    "a1",
    "u2",
    "a2",
  ]);
  expect(transcript.blocks.some((block) => block.temporary)).toBe(false);
});

test("terminal receipts alone cannot certify consumption of an unmatched input preview", () => {
  for (const status of [
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ] as const) {
    const page = {
      ...snapshot,
      messages: [
        message("u2", "user", "later"),
        message("a2", "assistant", "reply"),
      ],
    };
    const prior = applySnapshot(page);
    prior.blocks.push(pendingUser());
    const transcript = applySnapshot(
      { ...page, operations: [submissionReceipt(status)] },
      prior,
    );
    expect(
      transcript.blocks
        .filter((block) => block.role === "user")
        .map((block) => block.messageId),
    ).toEqual(["u2", "optimistic1"]);
  }
});

test("missing or unrelated receipts cannot retire a pending repeated prompt or alias it to newly loaded older history", () => {
  for (const receipt of [
    undefined,
    submissionReceipt("accepted"),
    submissionReceipt("running"),
    submissionReceipt("unknown"),
    { ...submissionReceipt("completed"), session_id: "other" },
    { ...submissionReceipt("completed"), method: "turn.retry" },
    { ...submissionReceipt("completed"), id: "other-operation" },
  ]) {
    const current = [
      message("u2", "user", "later"),
      message("a2", "assistant", "reply"),
    ];
    const prior = applySnapshot({ ...snapshot, messages: current });
    prior.blocks.push(pendingUser("repeated prompt"));
    const transcript = applySnapshot(
      {
        ...snapshot,
        messages: [
          message("u1", "user", "repeated prompt"),
          message("a1", "assistant", "old reply"),
          ...current,
        ],
        operations: receipt ? [receipt] : [],
      },
      prior,
    );
    expect(
      transcript.blocks
        .filter((block) => block.role === "user")
        .map((block) => block.messageId),
    ).toEqual(["u1", "u2", "optimistic1"]);
  }
});

test("a matching terminal submission still aliases through framework delivery and preserves its reasoning", () => {
  const old = message("u0", "user", "earlier");
  const prior = applySnapshot({ ...snapshot, messages: [old] });
  prior.blocks.push(pendingUser());
  applyEvent(
    prior,
    observed(1, 1, "reasoning_delta", { text: "live reasoning" }),
  );
  const transcript = applySnapshot(
    {
      ...snapshot,
      messages: [
        old,
        {
          ...message("framework", "user", "delivery"),
          source: "framework" as const,
        },
        {
          ...message("u1", "user", "first prompt"),
          submission_operation_id: "op1",
        },
        message("a1", "assistant", "answer"),
      ],
      operations: [submissionReceipt("completed")],
    },
    prior,
  );
  expect(
    transcript.blocks.some((block) => block.messageId === "optimistic1"),
  ).toBe(false);
  const reasoning = transcript.blocks.find(
    (block) => block.kind === "reasoning",
  )!;
  expect(reasoning.messageId).toBe("a1");
  expect(transcript.blocks.indexOf(reasoning)).toBeGreaterThan(
    transcript.blocks.findIndex((block) => block.messageId === "u1"),
  );
});

test("a still-running input uses its own consistent observed turn before a bounded response suffix", () => {
  const prior = createTranscript();
  const user = pendingUser();
  prior.blocks.push(user);
  applyEvent(prior, observed(1, 1, "reasoning_delta", { text: "thinking" }));
  const unchanged = JSON.stringify(prior);
  const transcript = applySnapshot(
    {
      ...snapshot,
      session: { ...snapshot.session, status: "running" },
      messages: [
        {
          ...message("a5", "assistant", "later response"),
          position: { epoch: 0, turn: 1, round: 5 },
        },
      ],
      operations: [submissionReceipt("running")],
    },
    prior,
  );
  expect(transcript.blocks[0].messageId).toBe("optimistic1");
  expect(
    transcript.blocks.findIndex((block) => block.messageId === "a5"),
  ).toBeGreaterThan(0);
  expect(transcript.blocks[0].position).toBe(user.position);
  const reasoning = transcript.blocks.find(
    (block) => block.kind === "reasoning",
  )!;
  expect(reasoning.preview?.canonicalMessageId).toBeUndefined();
  expect(reasoning.messageId).not.toBe("a5");
  expect(reasoning.temporary).toBe(true);
  expect(reasoning.stream).toBe("streaming");
  expect(JSON.stringify(prior)).toBe(unchanged);
});

test("unrelated or conflicting model scopes cannot relocate an unmatched pending input", () => {
  for (const conflicting of [false, true]) {
    const prior = createTranscript();
    prior.blocks.push(pendingUser());
    applyEvent(
      prior,
      observed(1, 1, "reasoning_delta", {
        operation_id: conflicting ? "op1" : "other-operation",
        text: "thinking",
      }),
    );
    if (conflicting)
      applyEvent(
        prior,
        observed(2, 1, "reasoning_delta", {
          operation_id: "op1",
          text: "conflicting turn",
        }),
      );
    const transcript = applySnapshot(
      {
        ...snapshot,
        session: { ...snapshot.session, status: "running" },
        messages: [
          {
            ...message("a5", "assistant", "later response"),
            position: { epoch: 0, turn: 1, round: 5 },
          },
        ],
        operations: [submissionReceipt("running")],
      },
      prior,
    );
    expect(transcript.blocks[0].messageId).toBe("a5");
    expect(
      transcript.blocks.findIndex((block) => block.messageId === "optimistic1"),
    ).toBeGreaterThan(0);
  }
});

test("second-turn partial reasoning stays in its own turn across running and final snapshots", () => {
  const first = {
    ...snapshot,
    messages: [message("u1", "user", "same prompt")],
  };
  let t = applySnapshot(first);
  applyEvent(t, observed(1, 1, "started"));
  applyEvent(t, observed(1, 1, "reasoning_delta", { text: "same thinking" }));
  applyEvent(t, observed(1, 1, "text_delta", { text: "first partial" }));
  applyEvent(t, observed(1, 1, "validated", { text: "first final" }));
  const settledFirst = {
    ...first,
    messages: [...first.messages, message("a1", "assistant", "first final")],
  };
  t = applySnapshot(settledFirst, t);
  const optimistic = createBlock("s1", "optimistic2", "text", "text", "user");
  optimistic.temporary = true;
  optimistic.operationId = "op2";
  optimistic.payload.text = "same prompt";
  t.blocks.push(optimistic);
  applyEvent(t, observed(2, 1, "started"));
  applyEvent(t, observed(2, 1, "reasoning_delta", { text: "same thinking" }));
  applyEvent(t, observed(2, 1, "text_delta", { text: "second partial" }));
  const running = {
    ...settledFirst,
    session: { ...snapshot.session, status: "running" as const },
    messages: [
      ...settledFirst.messages,
      {
        ...message("u2", "user", "same prompt"),
        submission_operation_id: "op2",
      },
    ],
  };
  t = applySnapshot(running, t);
  expect(turnContents(t)).toEqual([
    ["same thinking", "first final"],
    ["same thinking", "second partial"],
  ]);
  // Continued deltas use the original stream identity after optimistic -> native ID mapping.
  applyEvent(t, observed(2, 1, "text_delta", { text: " continued" }));
  expect(t.blocks.at(-1)?.payload.text).toBe("second partial continued");
  applyEvent(t, observed(2, 1, "validated", { text: "second final" }));
  const final = {
    ...running,
    session: snapshot.session,
    messages: [...running.messages, message("a2", "assistant", "second final")],
  };
  t = applySnapshot(final, t);
  t = applySnapshot(final, t);
  expect(turnContents(t)).toEqual([
    ["same thinking", "first final"],
    ["same thinking", "second final"],
  ]);
  expect(
    t.blocks.filter((b) => b.kind === "reasoning").map((b) => b.messageId),
  ).toEqual(["a1", "a2"]);
  expect(t.blocks.some((b) => b.temporary || b.stream === "streaming")).toBe(
    false,
  );
  expect(t.sessionStatus).toBe("idle");
  // A fresh API snapshot cannot recover reasoning that native history does not store.
  expect(applySnapshot(final).blocks.some((b) => b.kind === "reasoning")).toBe(
    false,
  );
});

test("reused model/tool IDs in distinct rounds keep partial arguments and thinking separate", () => {
  let t = applySnapshot(snapshot);
  applyEvent(t, observed(1, 1, "started"));
  applyEvent(t, observed(1, 1, "reasoning_delta", { text: "round one" }));
  applyEvent(
    t,
    observed(1, 1, "tool_call_delta", {
      index: 0,
      name: "read",
      arguments: '{"path":',
    }),
  );
  applyEvent(
    t,
    observed(1, 1, "tool_call_delta", {
      index: 0,
      id: "reused-tool",
      arguments: '"first"}',
    }),
  );
  applyEvent(t, observed(1, 1, "validated", { text: "" }));
  applyEvent(t, observed(1, 2, "started"));
  applyEvent(t, observed(1, 2, "reasoning_delta", { text: "round two" }));
  applyEvent(
    t,
    observed(1, 2, "tool_call_delta", {
      index: 0,
      id: "reused-tool",
      name: "read",
      arguments: '{"path":"second"}',
    }),
  );
  const cards = t.blocks.filter((b) => b.kind === "tool");
  expect(cards.map((b) => b.tool.input)).toEqual([
    { path: "first" },
    { path: "second" },
  ]);
  expect(new Set(cards.map((b) => b.id)).size).toBe(2);
  const progress = {
    ...observed(1, 2, "completed"),
    event: "tool",
    data: {
      operation_id: "op1",
      epoch: 0,
      turn: 1,
      round: 2,
      call_id: "reused-tool",
      phase: "completed",
    },
  };
  applyEvent(t, progress);
  expect(cards[0].tool.status).toBe("running");
  expect(cards[1].tool.status).toBe("completed");
  applyEvent(t, observed(1, 2, "invalidated"));
  expect(
    t.blocks.filter((b) => b.kind === "reasoning").map((b) => b.payload.text),
  ).toEqual(["round one", "round two"]);
  const canonical = {
    ...snapshot,
    messages: [
      ...snapshot.messages,
      {
        ...message("a-tool", "assistant", ""),
        tool_calls: [
          { id: "reused-tool", name: "read", arguments: { path: "first" } },
        ],
      },
    ],
  };
  t = applySnapshot(canonical, t);
  expect(t.blocks.map((b) => b.kind)).toEqual(["text", "reasoning", "tool"]);
  expect(t.blocks[1].messageId).toBe("a-tool");
  expect(t.blocks.some((b) => b.temporary || b.stream === "streaming")).toBe(
    false,
  );
});

test("tool-to-text round retains thinking and response in one renderer round", () => {
  let t = applySnapshot(snapshot);
  applyEvent(t, observed(1, 1, "reasoning_delta", { text: "before tool" }));
  const toolRound = {
    ...snapshot,
    session: { ...snapshot.session, status: "running" as const },
    messages: [
      ...snapshot.messages,
      {
        ...message("a-tool", "assistant", ""),
        tool_calls: [{ id: "tool", name: "read", arguments: {} }],
      },
    ],
  };
  t = applySnapshot(toolRound, t);
  applyEvent(t, observed(1, 2, "started"));
  applyEvent(t, observed(1, 2, "reasoning_delta", { text: "after tool" }));
  applyEvent(t, observed(1, 2, "text_delta", { text: "answer" }));
  const rounds = computeTurns(t)[0].rounds;
  expect(rounds).toHaveLength(2);
  expect(
    rounds[1].blockIndices.map((i: number) => t.blocks[i].payload.text),
  ).toEqual(["after tool", "answer"]);
});

test("stream and session identity cannot mutate retained history when call IDs repeat", () => {
  let t = applySnapshot(snapshot);
  applyEvent(t, observed(1, 1, "reasoning_delta", { text: "first" }));
  t = applySnapshot(
    {
      ...snapshot,
      messages: [...snapshot.messages, message("a1", "assistant", "answer")],
    },
    t,
  );
  const before = structuredClone(t.blocks);
  applyEvent(t, {
    ...observed(2, 1, "reasoning_delta", { text: "second" }),
    data: {
      ...(observed(2, 1, "reasoning_delta").data as object),
      operation_id: "new-operation",
      epoch: 1,
      text: "second",
    },
  });
  expect(t.blocks.slice(0, before.length)).toEqual(before);
  const other = applySnapshot(
    { ...snapshot, session: { ...snapshot.session, id: "other" } },
    t,
  );
  expect(other.blocks.some((b) => b.kind === "reasoning")).toBe(false);
});

test("idle timeout facts accept only bounded numeric evidence and localize the stalled stream", () => {
  const error = {
    code: "provider_timeout",
    message: "Model request timed out",
    details: {
      reason: "idle_timeout",
      timeout_ms: 60000,
      elapsed_ms: 90123,
      first_token_ms: 123,
      streamed_bytes: 8000,
      streamed_chars: 7000,
      body: "must never render",
    },
  };
  expect(wireFailure(error).details).toEqual({
    reason: "idle_timeout",
    timeout_ms: 60000,
    elapsed_ms: 90123,
    first_token_ms: 123,
    streamed_bytes: 8000,
    streamed_chars: 7000,
  });
  const text = failureText(error);
  for (const value of ["60000", "90123", "123", "8000", "7000"])
    expect(text).toContain(value);
  expect(text).not.toContain("must never render");
  expect(
    wireFailure({
      ...error,
      details: {
        reason: "idle_timeout",
        timeout_ms: -1,
        elapsed_ms: Infinity,
        first_token_ms: "123",
        streamed_bytes: Number.MAX_SAFE_INTEGER + 1,
        streamed_chars: 0,
      },
    }).details,
  ).toEqual({ reason: "idle_timeout", streamed_chars: 0 });
});

test("concrete failure projection retains independent count/byte, parse, signed I/O and tool facts without credentials", () => {
  const failure = {
    code: "limit",
    message: "Inbox capacity exceeded; api_key=private-credential",
    details: {
      reason: "inbox_entries",
      required_count: 2,
      budget_count: 0,
      required_bytes: 12,
      budget_bytes: 0,
      raw_os_error: -22,
      line: 7,
      column: 19,
      kind: "InvalidInput",
      provider_type: "capacity",
      provider_status: 429,
      tool_code: "invalid_argument",
      body: "private-body",
      prompt: "private-prompt",
      diagnostic: {
        code: "invalid_argument",
        layer: "host",
        phase: "validation",
        reason: "invalid type at field",
        json_line: 2,
        json_column: 8,
        operation_effects: "not_started",
        tool_args: "private-tool-args",
      },
    },
  };
  const projected = wireFailure(failure);
  expect(projected.details).toMatchObject({
    required_count: 2,
    budget_count: 0,
    required_bytes: 12,
    budget_bytes: 0,
    raw_os_error: -22,
    line: 7,
    column: 19,
  });
  const text = failureText(failure);
  for (const fact of [
    "2",
    "0",
    "12",
    "-22",
    "7",
    "19",
    "InvalidInput",
    "429",
    "invalid_argument",
    "invalid type at field",
  ])
    expect(text).toContain(fact);
  for (const secret of [
    "private-credential",
    "private-body",
    "private-prompt",
    "private-tool-args",
  ])
    expect(JSON.stringify(projected)).not.toContain(secret);
  expect(
    failureText({
      code: "io",
      message: "Failed to open cache",
      details: { reason: "directory is read-only", raw_os_error: -5 },
    }),
  ).toContain("directory is read-only");
});

test("configured display remains separate from the admitted Turn model across metadata projection", () => {
  const a = { provider_id: "provider-a", model: "model-a", variant: "low" };
  const b = { provider_id: "provider-b", model: "model-b", variant: null };
  const session = {
    ...snapshot.session,
    model: b.model,
    model_selection: b,
    applied_model_selection: a,
    turn_model_selection: a,
    pending_model_change: true,
  };
  expect(sessionView(session)).toMatchObject({
    model: { id: "model-b", providerId: "provider-b" },
    appliedModelSelection: a,
    turnModelSelection: a,
    pendingModelChange: true,
  });
  const transcript = applySnapshot({ ...snapshot, session });
  expect(transcript.model).toEqual({
    id: "model-a",
    providerId: "provider-a",
    variant: "low",
  });
  expect(
    applySnapshot(
      {
        ...snapshot,
        session: {
          ...session,
          applied_model_selection: b,
          turn_model_selection: null,
          pending_model_change: false,
        },
      },
      transcript,
    ).model,
  ).toEqual({ id: "model-b", providerId: "provider-b", variant: null });
});
