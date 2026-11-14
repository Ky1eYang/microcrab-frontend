import { test, expect } from "@playwright/test";
import {
  CLIENT_TOOL_DEFINITIONS,
  parseQuestions,
  parseTodos,
  questionResult,
  todosFromHistory,
  sameToolSchema,
} from "../src/client/client-tools";
import {
  ClientToolController,
  type ClientInvocation,
  type ClientBinding,
} from "../src/client/client-tool-controller";
import type { ApiClient } from "../src/client/api";
import {
  auditSelector,
  historicalToolSchema,
} from "../src/features/RequestAudit";
import { createBlock } from "../src/client/projector";

test("frozen MCP schemas compare structurally across server object ordering", () => {
  expect(
    sameToolSchema(
      {
        type: "object",
        properties: { path: { type: "string", description: "Path" } },
        required: ["path"],
      },
      {
        required: ["path"],
        properties: { path: { description: "Path", type: "string" } },
        type: "object",
      },
    ),
  ).toBe(true);
  expect(
    sameToolSchema({ required: ["a", "b"] }, { required: ["b", "a"] }),
  ).toBe(false);
  expect(sameToolSchema({ type: "string" }, { type: "number" })).toBe(false);
});
const args = {
  questions: [
    {
      id: "q",
      question: "Choose",
      options: [
        { id: "a", label: "Same" },
        { id: "b", label: "Same" },
      ],
      multiple: true,
    },
  ],
};
const call: ClientInvocation = {
  invocation_id: "inv",
  parent_session_id: "s",
  session_id: "s",
  call_id: "model-call",
  tool: "ask_user_question",
  arguments: args,
  epoch: 1,
  turn_id: 2,
  round_id: 3,
  catalog_digest: "digest",
  created_at_ms: 1,
  deadline_ms: Date.now() + 60000,
  status: "pending",
};
function harness(
  role: "observer" | "executor" = "executor",
  pending: ClientInvocation[] = [],
) {
  const commands: { method: string; params: any; session?: string }[] = [];
  const binding: ClientBinding = {
    role,
    lease_id: role === "executor" ? "lease" : undefined,
    catalog_digest: "digest",
    definitions: CLIENT_TOOL_DEFINITIONS,
    pending,
    calls: pending,
  };
  const api = {
    request: async (method: string, params: any, session?: string) => {
      commands.push({ method, params, session });
      return method === "client_tools.bind"
        ? structuredClone(binding)
        : { ...call, status: "completed", result: params.result };
    },
  } as unknown as ApiClient;
  const errors: unknown[] = [];
  return {
    controller: new ClientToolController(
      api,
      () => {},
      (e) => errors.push(e),
    ),
    commands,
    binding,
    errors,
  };
}
test("stable question IDs distinguish duplicate labels and validate custom/multiple answers", () => {
  const questions = parseQuestions(args);
  expect(
    questionResult(questions, [
      { id: "q", option_ids: ["a", "b"], custom: "other" },
    ]),
  ).toEqual({
    dismissed: false,
    answers: [{ id: "q", option_ids: ["a", "b"], custom: "other" }],
  });
  expect(() =>
    questionResult(questions, [{ id: "q", option_ids: ["Same"] }]),
  ).toThrow("Unknown option");
  expect(() =>
    parseQuestions({ questions: [args.questions[0], args.questions[0]] }),
  ).toThrow("Duplicate question");
  expect(questionResult(questions, undefined, true)).toEqual({
    dismissed: true,
    answers: [],
  });
  expect(() =>
    questionResult(
      parseQuestions({
        questions: [{ ...args.questions[0], multiple: false }],
      }),
      [{ id: "q", option_ids: ["a"], custom: "extra" }],
    ),
  ).toThrow();
});
test("full replacement todo supports clearing, cancelled and bounded payloads", () => {
  expect(parseTodos({ todos: [] })).toEqual([]);
  expect(
    parseTodos({ todos: [{ content: "retired", status: "cancelled" }] }),
  ).toEqual([{ content: "retired", status: "cancelled" }]);
  expect(() =>
    parseTodos({
      todos: Array.from({ length: 201 }, () => ({
        content: "x",
        status: "pending",
      })),
    }),
  ).toThrow();
  expect(() =>
    parseTodos({ todos: [{ content: "x", status: "done" }] }),
  ).toThrow();
  for (const def of CLIENT_TOOL_DEFINITIONS)
    expect(def.permissions[0].action).toBe("allow");
});
test("pending question reclaims after bind with lease and original invocation identity", async () => {
  const { controller, commands, binding } = harness("executor", [call]);
  await controller.bind("s", binding);
  expect(controller.questions).toHaveLength(1);
  await controller.answer("inv", [{ id: "q", option_ids: ["a"] }], false);
  expect(commands[1]).toEqual({
    method: "client_tools.result",
    session: "s",
    params: {
      lease_id: "lease",
      invocation_id: "inv",
      result: { dismissed: false, answers: [{ id: "q", option_ids: ["a"] }] },
    },
  });
  expect(controller.questions).toHaveLength(0);
});
test("observer cannot answer and recovered todo is never automatically replayed", async () => {
  const observer = harness("observer", [call]);
  await observer.controller.bind("s", observer.binding);
  expect(observer.controller.questions[0]?.disabled).toBe(true);
  await expect(observer.controller.answer("inv", [], true)).rejects.toThrow(
    "lease",
  );
  const todo = { ...call, tool: "update_todo_list", arguments: { todos: [] } };
  const executor = harness("executor", [todo]);
  await executor.controller.bind("s", executor.binding);
  executor.controller.receive("client_tool.requested", todo);
  expect(executor.commands).toHaveLength(1);
});
test("live todo executes once and immutable duplicate notifications do not replay", async () => {
  const h = harness();
  await h.controller.bind("s", h.binding);
  const todo = { ...call, tool: "update_todo_list", arguments: { todos: [] } };
  h.controller.receive("client_tool.requested", todo);
  h.controller.receive("client_tool.requested", todo);
  await expect.poll(() => h.commands.length).toBe(2);
  expect(h.commands[1].params.result).toEqual({ todos: [] });
});
test("historical audit uses explicit positions and historical provider-shaped tools", () => {
  const block = createBlock("s", "hash_content_id", "tool", "tool");
  block.position = { epoch: 8, turn: 2, round: 5 };
  block.callId = "c";
  expect(auditSelector(block, true)).toEqual({ epoch: 8, turn: 2, round: 5 });
  expect(auditSelector(block, false)).toEqual({
    epoch: 8,
    turn: 2,
    tool_call_id: "c",
  });
  const parameters = {
    type: "object",
    properties: { historical: { type: "boolean" } },
  };
  expect(
    historicalToolSchema(
      [{ type: "function", function: { name: "tool", parameters } }],
      "tool",
    ),
  ).toEqual(parameters);
  for (const tools of [
    [{ type: "function", function: { name: "tool", parameters } }],
    [{ type: "function", name: "tool", parameters }],
    [{ name: "tool", input_schema: parameters }],
    [
      {
        function_declarations: [
          { name: "other", parameters: {} },
          { name: "tool", parameters },
        ],
      },
    ],
    [{ functionDeclarations: [{ name: "tool", parameters }] }],
  ]) {
    expect(historicalToolSchema(tools, "tool")).toEqual(parameters);
    expect(historicalToolSchema(tools, "missing")).toBeUndefined();
  }
  expect(
    historicalToolSchema(
      [{ arbitrary: [{ name: "tool", parameters }] }],
      "tool",
    ),
  ).toBeUndefined();
  expect(
    historicalToolSchema(
      [{ function_declarations: [null, 1, { name: "tool", parameters }] }],
      "tool",
    ),
  ).toEqual(parameters);
  expect(
    auditSelector(createBlock("s", "msg_s_obsolete", "text"), false),
  ).toBeNull();
});
test("cancel request aborts an active external call without inventing a terminal record", async () => {
  const binding: ClientBinding = {
    role: "executor",
    lease_id: "lease",
    catalog_digest: "digest",
    definitions: [],
    calls: [],
    pending: [],
  };
  const externalCall: ClientInvocation = {
    ...call,
    tool: "external_records",
    arguments: {},
    deadline_ms: 0,
  };
  const commands: { method: string; params: any }[] = [];
  let signal: AbortSignal | undefined;
  let release!: (value: unknown) => void;
  const api = {
    request: async (method: string, params: any) => {
      commands.push({ method, params });
      return method === "client_tools.bind"
        ? structuredClone(binding)
        : { ...externalCall, status: "cancelled" };
    },
  } as unknown as ApiClient;
  const controller = new ClientToolController(
    api,
    () => {},
    () => {},
    async (_name, _args, abortSignal) => {
      signal = abortSignal;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  );
  await controller.bind("s", binding);
  controller.receive("client_tool.requested", externalCall);
  await expect.poll(() => !!signal).toBe(true);
  controller.receive("client_tool.cancel_requested", externalCall);
  expect(signal?.aborted).toBe(true);
  expect(controller.binding?.pending[0]?.status).toBe("pending");
  expect(commands.map((command) => command.method)).toEqual([
    "client_tools.bind",
  ]);
  release({ cancelled: true });
  await expect
    .poll(() => controller.binding?.calls[0]?.status)
    .toBe("cancelled");
  expect(commands[1].method).toBe("client_tools.result");
});

test("truncated call pages recover pending questions before presentation without replay", async () => {
  const binding: ClientBinding = {
    role: "executor",
    lease_id: "lease",
    catalog_digest: "digest",
    definitions: CLIENT_TOOL_DEFINITIONS,
    pending: [],
    calls: [],
    calls_truncated: true,
    pending_truncated: true,
  };
  const pages: number[] = [];
  const api = {
    request: async (method: string, params: { cursor: number }) => {
      if (method === "client_tools.bind") return binding;
      pages.push(params.cursor);
      return params.cursor === 0
        ? {
            calls: [{ ...call, invocation_id: "old", status: "completed" }],
            next_cursor: 1,
            total_calls: 2,
          }
        : { calls: [call], next_cursor: null, total_calls: 2 };
    },
  } as unknown as ApiClient;
  const controller = new ClientToolController(
    api,
    () => {},
    () => {},
  );
  await controller.bind("s", binding);
  expect(pages).toEqual([0, 1]);
  expect(controller.questions.map((q) => q?.id)).toEqual(["inv"]);
});
