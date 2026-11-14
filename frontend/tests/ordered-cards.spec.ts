import { expect, test } from "@playwright/test";
import { createBlock } from "../src/client/projector";
import {
  orderedCards,
  type CardBoundaries,
} from "../src/features/conversation/orderedCards";

function block(id: string, callId?: string, turn = 1, round = 1) {
  const value = createBlock(
    "s1",
    id,
    "text",
    callId ? "tool" : "text",
    callId ? "tool" : "assistant",
  );
  value.callId = callId;
  value.position = { epoch: 0, turn, round };
  return value;
}
const question = {
  id: "q1",
  sessionId: "s1",
  callId: "reused",
  epoch: 0,
  turnId: 1,
  roundId: 1,
  createdAt: 10,
};

test("question placement prefers canonical invocation then full call position, without crossing reused calls", () => {
  const old = block("old", "reused", 0);
  const exact = block("exact", "reused");
  const later = block("later", undefined, 2);
  const positions: CardBoundaries = new Map();
  const byPosition = orderedCards(
    [old, exact, later],
    [question],
    null,
    "s1",
    positions,
  );
  expect(byPosition.map((b) => b.messageId)).toEqual([
    "old",
    "exact",
    "question:q1",
    "later",
  ]);
  // Durable invocation identity wins even when an earlier same-call witness exists.
  later.clientInvocationId = "q1";
  const byInvocation = orderedCards(
    [old, exact, later],
    [question],
    null,
    "s1",
    positions,
  );
  expect(byInvocation.map((b) => b.messageId)).toEqual([
    "old",
    "exact",
    "later",
    "question:q1",
  ]);
  expect(
    orderedCards(
      [old],
      [{ ...question, sessionId: "other" }],
      null,
      "s1",
      new Map(),
    ),
  ).toEqual([old]);
  const delegate = block("delegate", "delegate-call");
  delegate.tool = {
    name: "delegate",
    status: "completed",
    input: {},
    childBinding: "execution",
    childSessionId: "child",
  };
  const childQuestion = {
    ...question,
    id: "child-question",
    sessionId: "child",
    parentSessionId: "s1",
  };
  const childRows = orderedCards(
    [old, delegate, later],
    [childQuestion],
    null,
    "s1",
    new Map(),
  );
  expect(childRows.map((b) => b.messageId)).toEqual([
    "old",
    "delegate",
    "question:child-question",
    "later",
  ]);
  expect(childRows[2].payload.question.sessionId).toBe("child");
  const childPositions: CardBoundaries = new Map();
  orderedCards([old], [childQuestion], null, "s1", childPositions);
  expect(
    orderedCards([old, later], [childQuestion], null, "s1", childPositions).map(
      (b) => b.messageId,
    ),
  ).toEqual(["old", "question:child-question", "later"]);
});

test("partial recovery never joins a reused call or borrows the visible session scope", () => {
  const old = block("old", "reused");
  const later = block("later", undefined, 2);
  const positions: CardBoundaries = new Map();
  // Recovery can supply a call ID before the complete durable position exists.
  const partial = { ...question, turnId: null, roundId: null };
  expect(
    orderedCards([old, later], [partial], null, "s1", positions).map(
      (row) => row.messageId,
    ),
  ).toEqual(["old", "later", "question:q1"]);
  const next = block("next", undefined, 3);
  expect(
    orderedCards([old, later, next], [partial], null, "s1", positions).map(
      (row) => row.messageId,
    ),
  ).toEqual(["old", "later", "question:q1", "next"]);
  expect(
    orderedCards(
      [old, later],
      [{ ...partial, sessionId: "child", parentSessionId: "other-parent" }],
      null,
      "s1",
      new Map(),
    ),
  ).toEqual([old, later]);
});

test("unmatched cards keep their observed boundary while later messages arrive and recover canonical identity", () => {
  const old = block("old");
  const later = block("later", undefined, 2);
  const unresolved = { id: "q2", sessionId: "s1", createdAt: 10 };
  const positions: CardBoundaries = new Map();
  expect(
    orderedCards([old], [unresolved], null, "s1", positions).map(
      (b) => b.messageId,
    ),
  ).toEqual(["old", "question:q2"]);
  expect(
    orderedCards([old, later], [unresolved], null, "s1", positions).map(
      (b) => b.messageId,
    ),
  ).toEqual(["old", "question:q2", "later"]);
  old.clientInvocationId = "q2";
  expect(
    orderedCards([old, later], [unresolved], null, "s1", positions).map(
      (b) => b.messageId,
    ),
  ).toEqual(["old", "question:q2", "later"]);
  const compact = {
    operation_id: "compact-1",
    sessionId: "s1",
    status: "failed",
  };
  const compactPositions: CardBoundaries = new Map();
  orderedCards([old], [], compact, "s1", compactPositions);
  expect(
    orderedCards([old, later], [], compact, "s1", compactPositions).map(
      (b) => b.messageId,
    ),
  ).toEqual(["old", "compact:compact-1", "later"]);
  expect(
    orderedCards(
      [old, later],
      [],
      { ...compact, status: "completed" },
      "s1",
      compactPositions,
    ),
  ).toEqual([old, later]);
});
