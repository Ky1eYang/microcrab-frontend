import { test, expect } from "@playwright/test";
import {
  CLIENT_TOOL_DEFINITIONS,
  parseQuestions,
  questionMode,
  recommendedQuestionResult,
  questionResult,
} from "../src/client/client-tools";
import {
  ClientToolController,
  type ClientBinding,
  type ClientInvocation,
} from "../src/client/client-tool-controller";
import type { ApiClient } from "../src/client/api";
const single = {
  id: "q",
  question: "Choose",
  options: [
    { id: "a", label: "First", recommended: true },
    { id: "b", label: "Second" },
  ],
};
const result = { dismissed: false, answers: [{ id: "q", option_ids: ["a"] }] };
function harness(call: ClientInvocation) {
  const commands: { method: string; params: any }[] = [];
  const binding: ClientBinding = {
    role: "executor",
    lease_id: "lease",
    catalog_digest: "digest",
    definitions: CLIENT_TOOL_DEFINITIONS,
    pending: [call],
    calls: [call],
  };
  const api = {
    request: async (method: string, params: any, sessionId: string) => {
      expect(sessionId).toBe(call.parent_session_id);
      expect(params).not.toHaveProperty("session_id");
      commands.push({ method, params });
      if (method === "client_tools.bind") return structuredClone(binding);
      if (method === "client_tools.prepare")
        return {
          ...call,
          prepared: true,
          timeout_result: params.timeout_result,
        };
      return { ...call, status: "completed", result: params.result };
    },
  } as unknown as ApiClient;
  return {
    controller: new ClientToolController(
      api,
      () => {},
      () => {},
    ),
    commands,
    binding,
  };
}
const call: ClientInvocation = {
  invocation_id: "i",
  parent_session_id: "s",
  session_id: "s",
  call_id: "c",
  tool: "ask_user_question",
  arguments: { questions: [single] },
  epoch: 0,
  turn_id: 1,
  round_id: 1,
  catalog_digest: "digest",
  status: "pending",
  created_at_ms: 1,
  deadline_ms: 1,
  interaction: true,
  blocking_mode: "blocking",
  prepared: false,
};
test("question schema declares frozen generic interaction budget and default mode", () => {
  expect(CLIENT_TOOL_DEFINITIONS[0].interaction).toEqual({
    mode_pointer: "/blocking_mode",
    wait_timeout_ms: 300000,
  });
  expect(questionMode({ questions: [single] })).toBe("blocking");
  expect(() =>
    parseQuestions({ blocking_mode: "invented", questions: [single] }),
  ).toThrow();
});
test("question parameters document nested values and parser omission defaults", () => {
  const schema = CLIENT_TOOL_DEFINITIONS[0].parameters as any;
  function described(node: any) {
    for (const child of Object.values(node.properties ?? {}) as any[]) {
      expect(typeof child.description).toBe("string");
      expect(child.description.length).toBeGreaterThan(0);
      described(child);
    }
    if (node.items) described(node.items);
  }
  described(schema);
  expect(
    parseQuestions({ questions: [{ id: "q", question: "Free text" }] }),
  ).toEqual([
    {
      id: "q",
      question: "Free text",
      options: [],
      multiple: false,
      custom: true,
    },
  ]);
  for (const field of ["header", "options", "multiple", "custom"])
    expect(() =>
      parseQuestions({
        questions: [{ id: "q", question: "Choose", [field]: null }],
      }),
    ).toThrow();
  expect(() =>
    parseQuestions({
      questions: [{ id: "q", question: "Choose", header: "" }],
    }),
  ).toThrow();
  expect(() =>
    parseQuestions({
      questions: [{ id: "q", question: "Choose", options: [], custom: false }],
    }),
  ).toThrow();
  expect(() =>
    parseQuestions({
      questions: [
        { ...single, options: [{ id: "a", label: "First", description: "" }] },
      ],
    }),
  ).toThrow();
});

test("complete fallback uses only explicit valid recommendations across every question", () => {
  expect(recommendedQuestionResult({ questions: [single] })).toEqual({
    ...result,
    source: "timeout_recommendation",
  });
  expect(
    questionResult(parseQuestions({ questions: [single] }), result.answers),
  ).toEqual(result);
  expect(
    recommendedQuestionResult({
      questions: [single, { id: "custom", question: "Free answer" }],
    }),
  ).toBeUndefined();
  expect(
    recommendedQuestionResult({
      questions: [
        {
          ...single,
          options: single.options.map((o) => ({ ...o, recommended: true })),
        },
      ],
    }),
  ).toBeUndefined();
  expect(
    recommendedQuestionResult({
      questions: [
        {
          ...single,
          multiple: true,
          options: single.options.map((o) => ({ ...o, recommended: true })),
        },
      ],
    }),
  ).toEqual({
    dismissed: false,
    answers: [{ id: "q", option_ids: ["a", "b"] }],
    source: "timeout_recommendation",
  });
  expect(
    recommendedQuestionResult({
      blocking_mode: "deferred",
      questions: [single],
    }),
  ).toBeUndefined();
});
test("reclaimed blocking question declares complete fallback without submitting a user result", async () => {
  const h = harness(call);
  await h.controller.bind("s", h.binding);
  await expect.poll(() => h.commands.length).toBe(2);
  expect(h.commands[1]).toEqual({
    method: "client_tools.prepare",
    params: {
      lease_id: "lease",
      invocation_id: "i",
      timeout_result: { ...result, source: "timeout_recommendation" },
    },
  });
  expect(h.commands.some((c) => c.method === "client_tools.result")).toBe(
    false,
  );
});
test("missing recommendation prepares PAUSE without invented picks and paused remains answerable", async () => {
  const paused = {
    ...call,
    status: "paused" as const,
    arguments: { questions: [{ id: "q", question: "Custom answer" }] },
  };
  const h = harness(paused);
  await h.controller.bind("s", h.binding);
  await expect.poll(() => h.commands.length).toBe(2);
  expect(h.commands[1].params).toEqual({
    lease_id: "lease",
    invocation_id: "i",
  });
  expect(h.controller.questions[0]?.paused).toBe(true);
  expect(h.controller.questions[0]?.disabled).toBe(false);
  await h.controller.answer(
    "i",
    [{ id: "q", option_ids: [], custom: "late answer" }],
    false,
  );
  expect(h.commands.at(-1)?.params.result).toEqual(
    questionResult(parseQuestions(paused.arguments), [
      { id: "q", option_ids: [], custom: "late answer" },
    ]),
  );
});
test("deferred questions have no timeout fallback or deadline-based answer disable", async () => {
  const deferred = {
    ...call,
    blocking_mode: "deferred" as const,
    deadline_ms: 0,
    arguments: { blocking_mode: "deferred", questions: [single] },
  };
  const h = harness(deferred);
  await h.controller.bind("s", h.binding);
  expect(h.commands).toHaveLength(1);
  expect(h.controller.questions[0]?.blockingMode).toBe("deferred");
  await h.controller.answer("i", [{ id: "q", option_ids: ["a"] }], false);
  expect(h.commands.at(-1)?.params.result).toEqual(result);
});
