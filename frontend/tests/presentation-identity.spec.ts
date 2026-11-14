import { expect, test } from "@playwright/test";
import type { FeatureBlock } from "../src/features/shared";
import {
  historyBranchReplaced,
  presentationIdentity,
  presentationIdentityChanged,
} from "../src/features/conversation/presentationIdentity";

const row: FeatureBlock = {
  id: "native-row",
  sessionId: "s1",
  messageId: "canonical-message",
  partId: "part-1",
  callId: "call-1",
  role: "tool",
  kind: "tool",
  stream: "done",
  payload: { text: "Observed output" },
};
const history = {
  lineage: "selected",
  epoch: 0,
  start_cursor: 0,
  end_cursor: 1,
  message_count: 1,
  turns: [],
};

test("presentation authority accepts hydration and forward epochs but rejects branch replacement and rollback", () => {
  expect(historyBranchReplaced(undefined, history)).toBe(false);
  expect(historyBranchReplaced(history, { ...history, epoch: 1 })).toBe(false);
  expect(historyBranchReplaced(history, { ...history, lineage: "other" })).toBe(
    true,
  );
  expect(historyBranchReplaced({ ...history, epoch: 2 }, history)).toBe(true);
});

test("presentation survivors require canonical identity, not equal output or reused native coordinates", () => {
  const identity = presentationIdentity(row);
  expect(
    presentationIdentityChanged(identity, {
      ...row,
      payload: { text: "Updated output" },
    }),
  ).toBe(false);
  for (const replacement of [
    { ...row, messageId: "other-message" },
    { ...row, partId: "other-part" },
    { ...row, sessionId: "child" },
    { ...row, callId: "other-call" },
  ])
    expect(presentationIdentityChanged(identity, replacement)).toBe(true);
});

test("native display promotion is continuous only for its exact invocation", () => {
  const display = { ...row, messageId: "", temporary: true };
  const identity = presentationIdentity(display);
  expect(presentationIdentityChanged(identity, row)).toBe(false);
  expect(
    presentationIdentityChanged(identity, { ...row, callId: "other-call" }),
  ).toBe(true);
  expect(presentationIdentityChanged(presentationIdentity(row), display)).toBe(
    true,
  );
});

test("durable graph producer rows survive canonical binding without sharing sibling identity", () => {
  const producer = {
    ...row,
    id: "thought",
    kind: "reasoning",
    displayGraphId: "thought",
    messageId: "producer-message",
  };
  const identity = presentationIdentity(producer);
  expect(
    presentationIdentityChanged(identity, {
      ...producer,
      messageId: "canonical-answer",
    }),
  ).toBe(false);
  expect(
    presentationIdentity({ ...producer, id: "thought:other-part" }),
  ).not.toBe(identity);
  expect(
    presentationIdentity({ ...producer, displayGraphId: "replacement" }),
  ).not.toBe(identity);
  expect(presentationIdentity({ ...producer, sessionId: "child" })).not.toBe(
    identity,
  );
});

test("equal audited request hashes never identify independent helper invocations", () => {
  const helper = {
    ...row,
    kind: "internal-assistant",
    messageId: "equal-request-hash",
    callId: undefined,
    payload: {
      text: "Same response",
      auditIdentity: '[0,1,1,"review","head-1","call-1"]',
    },
  };
  const identity = presentationIdentity(helper);
  expect(
    presentationIdentity({
      ...helper,
      payload: {
        ...helper.payload,
        auditIdentity: '[0,2,1,"review","head-2","call-2"]',
      },
    }),
  ).not.toBe(identity);
  expect(
    presentationIdentityChanged(identity, {
      ...helper,
      payload: { ...helper.payload, text: "Updated response" },
    }),
  ).toBe(false);
  const model = {
    ...row,
    kind: "model-request",
    messageId: "equal-request-hash",
    callId: undefined,
    payload: { text: "", auditTimingKey: "model-input:call-1" },
  };
  expect(
    presentationIdentity({
      ...model,
      payload: { ...model.payload, auditTimingKey: "model-input:call-2" },
    }),
  ).not.toBe(presentationIdentity(model));
});
